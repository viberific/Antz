import { Ant, AntCaste, AntTask, CELL_SIZE, GRID_W } from './types';
import type { AntColonySimulation } from './colony';
import type { CameraMode } from './camera2d';
import {
  CASTE_NOTES,
  CREATURE_DOING,
  CREATURE_NOTES,
  EVENT_NOTES,
  EventNote,
  INTRUDER_DOING,
  INTRUDER_NOTES,
  PAYLOAD_LABEL,
  PLACE_LABEL,
  TASK_NOTES,
  lifeStage,
} from './fieldNotes';

export type SubjectKind = 'ant' | 'creature' | 'intruder';

export interface Subject {
  kind: SubjectKind;
  id: number;
}

/** What the overlay draws. */
export interface AnnotationView {
  /** a callout is tied to one animal; a banner is a lower-third about something that happened */
  layout: 'callout' | 'banner';
  /** changes whenever the text does */
  key: string;
  kicker: string;
  title: string;
  term?: string;
  body: string;
  /** a second paragraph, shown while following an ant */
  aside?: string;
  chips: string[];
  accent: string;
  /** 0..1 fade */
  alpha: number;
  subject?: Subject;
}

export interface AnnotatorHost {
  mode(): CameraMode;
  followId(): number | null;
  /** where a subject is on the canvas, in pixels; null if it is not drawn */
  locate(s: Subject): { x: number; y: number } | null;
  size(): { w: number; h: number };
}

interface Active {
  view: Omit<AnnotationView, 'alpha'>;
  subject?: Subject;
  task?: AntTask;
  startedAt: number;
  /** callouts end by themselves after this many seconds (Infinity while following) */
  duration: number;
}

/** only these behaviours are about the load, so only then is the payload worth a chip */
const CARRYING_TASKS = new Set<AntTask>([
  AntTask.RETURNING_WITH_FOOD,
  AntTask.STORING_FOOD,
  AntTask.CARRYING_SOIL,
  AntTask.CARRYING_CHAFF,
  AntTask.CARRYING_LEAF,
  AntTask.MOVING_BROOD,
  AntTask.CLEARING_TRAIL,
  AntTask.NECROPHORESIS,
  AntTask.GROUP_TRANSPORT,
  AntTask.HUSKING_SEED,
]);

const FADE_IN = 0.7;
const FADE_OUT = 0.5;
/** quiet time between two annotations, so the screen is never crowded */
const GAP = 1.0;
/** every annotation stays up for at least this long (seconds, not counting the fades) */
export const HOLD_MIN = 10;
/** ...and for this long when the text is long */
export const HOLD_MAX = 15;
/** text length (characters) at which the hold reaches HOLD_MAX */
const HOLD_LONG_CHARS = 220;

/** 10–15 seconds, scaled by how much there is to read */
export function holdFor(view: Pick<AnnotationView, 'kicker' | 'title' | 'term' | 'body' | 'chips'>): number {
  const chars = view.kicker.length + view.title.length + (view.term?.length ?? 0) + view.body.length + view.chips.join(' ').length;
  return HOLD_MIN + (HOLD_MAX - HOLD_MIN) * Math.min(1, chars / HOLD_LONG_CHARS);
}

/**
 * Chooses what to annotate, one thing at a time.
 *
 * While the camera roams, it picks the most interesting animal on screen, favouring behaviours it has not
 * explained lately, and holds the caption long enough to read. While following an ant, the caption stays with that ant.
 * Notable colony events appear as lower-third banners and take priority over ant callouts.
 */
export class Annotator {
  public enabled = true;

  private active: Active | null = null;
  private alpha = 0;
  private ending = false;
  private gap = 1;
  private pickClock = 0;
  private pending: { note: EventNote; at: number }[] = [];
  /** when the last banner finished: ants get the screen for a while before the next one */
  private bannerEnd = -1e9;
  private readonly shown = new Map<string, number>();
  private readonly seenEvents = new Set<string>();
  private readonly taskSince = new Map<number, { task: AntTask; since: number }>();
  private trackClock = 0;
  private primed = false;

  /** Advance one frame. Returns what to draw, or null when nothing is showing. */
  public update(sim: AntColonySimulation, dt: number, host: AnnotatorHost): AnnotationView | null {
    const now = sim.simTime;
    this.pollEvents(sim);
    this.trackTasks(sim, dt);

    if (this.active) {
      if (!this.ending) {
        this.alpha = Math.min(1, this.alpha + dt / FADE_IN);
        if (!this.enabled || !this.stillValid(sim, host, now)) this.ending = true;
      }
      if (this.ending) {
        this.alpha -= dt / FADE_OUT;
        if (this.alpha <= 0) {
          this.alpha = 0;
          this.active = null;
          this.ending = false;
          this.gap = host.mode() === 'follow' ? 0.35 : GAP;
        }
      }
    } else {
      this.gap -= dt;
      this.pickClock += dt;
      if (this.enabled && this.gap <= 0 && this.pickClock >= 0.4) {
        this.pickClock = 0;
        this.startNext(sim, host, now);
      }
    }
    if (!this.active) return null;
    return { ...this.active.view, alpha: this.alpha };
  }

  /** Called when the annotation toggle is switched off, so everything fades and nothing queued pops up later. */
  public clear(): void {
    this.pending.length = 0;
    if (this.active) this.ending = true;
  }

  // ---------------------------------------------------------------- events

  private pollEvents(sim: AntColonySimulation): void {
    const fresh = sim.events.filter((e) => !this.seenEvents.has(`${e.time}|${e.text}`));
    for (const e of fresh) this.seenEvents.add(`${e.time}|${e.text}`);
    if (this.seenEvents.size > 64) {
      const keep = sim.events.map((e) => `${e.time}|${e.text}`);
      this.seenEvents.clear();
      for (const k of keep) this.seenEvents.add(k);
    }
    // whatever was already in the log when we started is history, not news
    if (!this.primed) {
      this.primed = true;
      return;
    }
    if (!this.enabled) return;
    for (const e of fresh) {
      const note = EVENT_NOTES.find((n) => n.match.test(e.text));
      if (!note || this.pending.some((p) => p.note.id === note.id)) continue;
      const last = this.shown.get('event:' + note.id);
      if (last !== undefined && sim.simTime - last < note.cooldown) continue;
      this.pending.push({ note, at: sim.simTime });
      if (this.pending.length > 5) this.pending.shift();
    }
  }

  private trackTasks(sim: AntColonySimulation, dt: number): void {
    this.trackClock += dt;
    if (this.trackClock < 0.25) return;
    this.trackClock = 0;
    for (const a of sim.ants) {
      const t = this.taskSince.get(a.id);
      if (!t || t.task !== a.task) this.taskSince.set(a.id, { task: a.task, since: sim.simTime });
    }
    if (this.taskSince.size > sim.ants.length + 64) {
      const live = new Set(sim.ants.map((a) => a.id));
      for (const id of this.taskSince.keys()) if (!live.has(id)) this.taskSince.delete(id);
    }
  }

  // ---------------------------------------------------------------- lifecycle

  private stillValid(sim: AntColonySimulation, host: AnnotatorHost, now: number): boolean {
    const a = this.active!;
    const age = now - a.startedAt;
    if (a.view.layout === 'banner') return age < a.duration;
    // an event that matters more than any one ant takes the screen, once the current caption has had time to be read
    if (age > HOLD_MIN && this.bannerWaiting(now, host)) return false;
    if (age > a.duration) return false;
    const s = a.subject;
    if (!s) return false;
    const { w, h } = host.size();
    const p = host.locate(s);
    if (!p || p.x < w * 0.04 || p.x > w * 0.96 || p.y < h * 0.08 || p.y > h * 0.92) return false;
    if (s.kind === 'ant') {
      const ant = sim.ants.find((q) => q.id === s.id);
      if (!ant || ant.task !== a.task) return false;
      if (host.mode() === 'follow' && host.followId() !== s.id) return false;
    } else if (host.mode() === 'follow') {
      return false;
    }
    return true;
  }

  private startNext(sim: AntColonySimulation, host: AnnotatorHost, now: number): void {
    // news first, but not while following an ant, and never back to back
    this.pending = this.pending.filter((p) => now - p.at < 45);
    while (this.bannerWaiting(now, host)) {
      const note = this.pending.shift()!.note;
      const last = this.shown.get('event:' + note.id);
      if (last !== undefined && now - last < note.cooldown) continue;
      this.shown.set('event:' + note.id, now);
      if (note.creature) this.shown.set('creature:' + note.creature, now);
      const bannerView: Omit<AnnotationView, 'alpha'> = {
        layout: 'banner',
        key: 'event:' + note.id + ':' + now.toFixed(0),
        kicker: note.kicker,
        title: note.title,
        body: note.body,
        chips: [],
        accent: note.accent,
      };
      this.begin(bannerView, undefined, undefined, now, holdFor(bannerView));
      this.bannerEnd = now + this.active!.duration;
      return;
    }

    const pick = host.mode() === 'follow' ? this.pickFollowed(sim, host) : this.pickBest(sim, host, now);
    if (!pick) return;
    const built = this.build(sim, pick, host.mode() === 'follow');
    if (!built) return;
    this.shown.set(this.cooldownKey(pick, sim), now);
    if (pick.kind === 'ant') {
      const ant = sim.ants.find((q) => q.id === pick.id)!;
      this.shown.set('ant:' + pick.id, now);
      this.shown.set('caste:' + ant.caste, now);
    }
    const dur = host.mode() === 'follow' ? Infinity : holdFor(built.view);
    this.begin(built.view, pick, built.task, now, dur);
  }

  private bannerWaiting(now: number, host: AnnotatorHost): boolean {
    return this.pending.length > 0 && host.mode() !== 'follow' && now - this.bannerEnd >= 9;
  }

  private begin(view: Omit<AnnotationView, 'alpha'>, subject: Subject | undefined, task: AntTask | undefined, now: number, duration: number): void {
    this.active = { view, subject, task, startedAt: now, duration };
    this.alpha = 0;
    this.ending = false;
  }

  // ---------------------------------------------------------------- choosing

  private cooldownKey(s: Subject, sim: AntColonySimulation): string {
    if (s.kind === 'ant') return 'task:' + (sim.ants.find((q) => q.id === s.id)?.task ?? '');
    if (s.kind === 'creature') return 'creature:' + (sim.creatures.find((c) => c.id === s.id)?.kind ?? '');
    return 'intruder:' + (sim.intruders.find((m) => m.id === s.id)?.species ?? '');
  }

  private fresh(key: string, now: number, span: number, floor: number): number {
    const t = this.shown.get(key);
    if (t === undefined) return 1;
    const f = Math.min(1, (now - t) / span);
    return floor + (1 - floor) * f;
  }

  private pickFollowed(sim: AntColonySimulation, host: AnnotatorHost): Subject | null {
    const id = host.followId();
    if (id === null) return null;
    const ant = sim.ants.find((a) => a.id === id);
    if (!ant || !TASK_NOTES[ant.task]) return null;
    const since = this.taskSince.get(id);
    if (since && sim.simTime - since.since < 0.8) return null;
    return { kind: 'ant', id };
  }

  private pickBest(sim: AntColonySimulation, host: AnnotatorHost, now: number): Subject | null {
    const { w, h } = host.size();
    const cx = w / 2;
    const cy = h / 2;
    const half = Math.hypot(cx, cy);
    let best: Subject | null = null;
    let bestScore = 0.9;

    const consider = (s: Subject, interest: number, keys: [string, number, number][]): void => {
      const p = host.locate(s);
      if (!p || p.x < w * 0.12 || p.x > w * 0.88 || p.y < h * 0.16 || p.y > h * 0.84) return;
      let f = 1;
      for (const [k, span, floor] of keys) f *= this.fresh(k, now, span, floor);
      const central = 1 - 0.45 * (Math.hypot(p.x - cx, p.y - cy) / half);
      const score = interest * f * central + Math.random() * 0.25;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    };

    for (const a of sim.ants) {
      const note = TASK_NOTES[a.task];
      if (!note || a.carriedById != null) continue;
      const since = this.taskSince.get(a.id);
      if (!since || now - since.since < 1.2) continue;
      let interest = note.interest;
      if (a.caste === AntCaste.QUEEN || a.caste === AntCaste.GYNE || a.caste === AntCaste.MALE) interest += 1.2;
      consider({ kind: 'ant', id: a.id }, interest, [
        ['task:' + a.task, 30, 0.2],
        ['ant:' + a.id, 80, 0.15],
        ['caste:' + a.caste, 20, 0.6],
      ]);
    }
    for (const c of sim.creatures) {
      consider({ kind: 'creature', id: c.id }, CREATURE_NOTES[c.kind].interest, [['creature:' + c.kind, 100, 0.1]]);
    }
    for (const m of sim.intruders) {
      consider({ kind: 'intruder', id: m.id }, INTRUDER_NOTES[m.species].interest, [['intruder:' + m.species, 90, 0.15]]);
    }
    return best;
  }

  // ---------------------------------------------------------------- writing

  private build(sim: AntColonySimulation, s: Subject, following: boolean): { view: Omit<AnnotationView, 'alpha'>; task?: AntTask } | null {
    if (s.kind === 'ant') {
      const a = sim.ants.find((q) => q.id === s.id);
      const note = a && TASK_NOTES[a.task];
      if (!a || !note) return null;
      const caste = CASTE_NOTES[a.caste];
      const chips = [lifeStage(a.age, a.maxAge, a.isCallow), this.placeOf(sim, a)];
      if (a.payload && PAYLOAD_LABEL[a.payload] && CARRYING_TASKS.has(a.task)) chips.push(PAYLOAD_LABEL[a.payload]);
      return {
        task: a.task,
        view: {
          layout: 'callout',
          key: `ant:${a.id}:${a.task}`,
          kicker: caste.kicker,
          title: note.title,
          term: note.term,
          body: note.body,
          aside: following ? caste.body : undefined,
          chips,
          accent: caste.accent,
          subject: s,
        },
      };
    }
    if (s.kind === 'creature') {
      const c = sim.creatures.find((q) => q.id === s.id);
      if (!c) return null;
      const note = CREATURE_NOTES[c.kind];
      const doing = CREATURE_DOING[c.state];
      return {
        view: {
          layout: 'callout',
          key: `creature:${c.id}`,
          kicker: note.kicker,
          title: note.title,
          term: note.term,
          body: note.body,
          chips: doing ? [doing] : [],
          accent: note.accent,
          subject: s,
        },
      };
    }
    const m = sim.intruders.find((q) => q.id === s.id);
    if (!m) return null;
    const note = INTRUDER_NOTES[m.species];
    const doing = m.behavior ? INTRUDER_DOING[m.behavior] : undefined;
    return {
      view: {
        layout: 'callout',
        key: `intruder:${m.id}`,
        kicker: note.kicker,
        title: note.title,
        term: note.term,
        body: note.body,
        chips: doing ? [doing] : [],
        accent: note.accent,
        subject: s,
      },
    };
  }

  /** Which chamber, tunnel or surface the ant is in. */
  private placeOf(sim: AntColonySimulation, a: Ant): string {
    for (const c of sim.chambers) {
      const dx = (a.x - c.x) / c.rx;
      const dy = (a.y - c.y) / c.ry;
      if (dx * dx + dy * dy < 1.15) return PLACE_LABEL[c.type];
    }
    const gx = Math.min(GRID_W - 1, Math.max(0, Math.floor(a.x / CELL_SIZE)));
    return a.y < sim.grid.surfaceY[gx] + CELL_SIZE ? 'Surface' : 'Tunnel';
  }
}
