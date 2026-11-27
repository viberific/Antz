export const WORLD_W = 1440;
export const WORLD_H = 880;
export const CELL_SIZE = 6;
export const GRID_W = Math.floor(WORLD_W / CELL_SIZE); // 240
export const GRID_H = Math.floor(WORLD_H / CELL_SIZE); // 146

export const CASE_LEFT = 48;
export const CASE_RIGHT = 1392;
export const CASE_TOP = 56;
export const CASE_BOTTOM = 840;
export const SURFACE_BASE_Y = 232;

export enum CellType {
  AIR = 0,
  TUNNEL = 1,
  TOPSOIL = 2,
  SUBSOIL = 3,
  DEEP_CLAY = 4,
  PEBBLE = 5,
  GLASS_WALL = 6,
  ROOT = 7,
}

export enum AntCaste {
  QUEEN = 'Queen',
  WORKER = 'Forager',
  NURSE = 'Nurse',
  EXCAVATOR = 'Excavator',
  SOLDIER = 'Soldier',
  /** winged virgin queen, reared for the nuptial flight */
  GYNE = 'Gyne',
  /** winged male: lives only to mate on the nuptial flight */
  MALE = 'Male',
}

export enum AntTask {
  IDLE = 'Resting',
  FORAGING_SCOUT = 'Scouting Surface',
  FOLLOWING_FOOD_TRAIL = 'Following Scent Trail',
  RETURNING_WITH_FOOD = 'Carrying Food Home',
  STORING_FOOD = 'Storing in Granary',
  TENDING_QUEEN = 'Tending Queen',
  FEEDING_LARVA = 'Feeding Larva',
  MOVING_BROOD = 'Relocating Brood',
  EXCAVATING = 'Excavating Tunnel',
  CARRYING_SOIL = 'Depositing Excavated Soil',
  TROPHALLAXIS = 'Sharing Nutrition (Trophallaxis)',
  PATROLLING = 'Guarding Entrance',
  DEFENDING = 'Repelling Intruder',
  NECROPHORESIS = 'Clearing Refuse',
  LAYING_EGG = 'Laying Egg',
  DRINKING_DEW = 'Collecting Moisture',
  GREETING = 'Antennal Greeting',
  GROOMING = 'Grooming',
  FLEEING = 'Evading Intruder',
  SIGNALING_FOOD = 'Signaling Food Discovery',
  TENDING_FUNGUS = 'Tending Fungus Garden',
  SEEKING_REST = 'Heading Home to Rest',
  EATING = 'Eating from Stores',
  REPAIRING = 'Repairing Storm Damage',
  TANDEM_LEADING = 'Leading Tandem Run',
  TANDEM_FOLLOWING = 'Following Tandem Run',
  TENDING_APHIDS = 'Milking Aphids',
  HUSKING_SEED = 'Husking Seeds',
  CARRYING_CHAFF = 'Carrying Chaff to Midden',
  REPLETE = 'Living Honeypot (Replete)',
  ALLOGROOMING = 'Grooming Nestmate',
  HELPING_ECLOSION = 'Helping Callow Emerge',
  RESCUING = 'Digging Out Buried Nestmate',
  BURIED = 'Buried (Calling for Help)',
  CARRYING_NESTMATE = 'Carrying Injured Nestmate',
  BEING_CARRIED = 'Being Carried',
  GROUP_TRANSPORT = 'Group-Carrying Prey',
  CLEARING_TRAIL = 'Clearing Trail Debris',
  CANNIBALIZING = 'Eating Eggs (Famine)',
  NUPTIAL_FLIGHT = 'Nuptial Flight',
  WAITING_TO_SWARM = 'Waiting for Flight Weather',
  CLUSTERING = 'Overwintering Cluster',
  SEALING_ENTRANCE = 'Sealing Entrance',
  BACKFILLING = 'Backfilling Old Gallery',
}

export enum PayloadType {
  NONE = 0,
  SEED = 1,
  HONEYDEW = 2,
  PROTEIN = 3,
  SOIL = 4,
  EGG = 5,
  LARVA = 6,
  PUPA = 7,
  FUNGUS = 8,
  REFUSE = 9,
  /** seed husks stripped off in the granary */
  CHAFF = 10,
  /** a twig or grit cleared off a busy trail */
  DEBRIS = 11,
}

export enum BroodStage {
  EGG = 'Egg',
  LARVA = 'Larva',
  PUPA = 'Pupa',
}

export enum ChamberType {
  ROYAL = 'Royal Chamber',
  NURSERY = 'Brood Nursery',
  GRANARY = 'Granary',
  FUNGUS = 'Fungus Garden',
  MIDDEN = 'Refuse Midden',
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface Ant {
  id: number;
  caste: AntCaste;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  targetAngle: number;
  speed: number;
  energy: number;
  hunger: number;
  hydration: number;
  age: number;
  maxAge: number;
  isCallow: boolean;
  callowTimer: number;
  task: AntTask;
  payload: PayloadType;
  payloadValue: number;
  payloadId: number | null;
  stateTimer: number;
  pheromoneDropTimer: number;
  gaitPhase: number;
  antennaPhase: number;
  path: Vec2[];
  pathIndex: number;
  targetPos: Vec2 | null;
  targetChamberId: number | null;
  trophallaxisPartnerId: number | null;
  lastPathCalcTime: number;
  stuckTimer: number;
  prevX: number;
  prevY: number;
  greetCooldown: number;
  recruitFoodPos?: Vec2 | null;
  signalCooldown?: number;
  /** committed surface trail-following direction (-1 left / +1 right) and seconds left before re-deciding */
  trailDir?: number;
  trailCommit?: number;
  /** locomotion pace multiplier (0 = stopped, 1 = full stride), eased toward a task-dependent target */
  pace?: number;
  /** seconds left in a brief stop (sampling the air, antennating food, ...) */
  pauseTimer?: number;
  /** seconds until this ant may next settle down for a rest */
  restCooldown?: number;
  /** chamber an ant is walking to in order to rest */
  restChamberId?: number;
  /** >=1: how much longer the rendered 3D walking route is than the 2D sim step (set by the renderer) */
  surfaceStretch?: number;
  hp?: number;
  maxHp?: number;
  /** brood item or queen this ant is currently working for */
  targetId?: number | null;
  /** grid index of the cell being excavated, -1 when not digging */
  digIdx?: number;
  /** seconds spent outside on the current foraging trip */
  excursion?: number;
  /** which navigation goal the current `path` was built for */
  navKey?: string;
  attackCd?: number;
  lastHitTime?: number;
  /** honeypot replete: 0..1 how swollen with stored liquid food (undefined = not a replete) */
  replete?: number;
  /** tandem running partners */
  tandemLeaderId?: number | null;
  tandemFollowerId?: number | null;
  tandemTimer?: number;
  /** seconds of air left while buried by a cave-in (undefined = not buried) */
  buried?: number;
  /** social carrying: who is carrying this ant / whom this ant carries */
  carriedById?: number | null;
  carryingAntId?: number | null;
  /** alates: airborne on the nuptial flight */
  flying?: boolean;
  /** excavators: grid cell of the disused gallery this soil load is going into (-1 = to the mound) */
  backfill?: number;
  /** personality, each 0..1: nerve (stands and fights, goes out at night/in marginal weather), diligence (pace, rests
   *  less) and sociability (greets, shares and groups up more) */
  bold?: number;
  industry?: number;
  social?: number;
}

export interface BroodItem {
  id: number;
  stage: BroodStage;
  x: number;
  y: number;
  progress: number;
  nutrition: number;
  carriedByAntId: number | null;
  chamberId: number | null;
  wigglePhase: number;
  /** seconds a larva has gone without food */
  starve?: number;
  /** non-viable egg laid as food for larvae when the colony is short */
  trophic?: boolean;
  /** reared as a winged sexual (gyne or male) */
  sexual?: 'gyne' | 'male';
  /** a finished pupa waiting for a nurse to help it out of its cocoon */
  ecloseWait?: number;
}

export interface FoodSource {
  id: number;
  type: PayloadType.SEED | PayloadType.HONEYDEW | PayloadType.PROTEIN | PayloadType.FUNGUS;
  x: number;
  y: number;
  amount: number;
  maxAmount: number;
  radius: number;
  storedInChamberId: number | null;
  vy?: number;
  falling?: boolean;
  /** a big insect carcass that takes several ants to drag home */
  large?: boolean;
  /** seeds: husk already stripped off */
  husked?: boolean;
}

export interface Aphid {
  id: number;
  x: number;
  y: number;
  /** honeydew accumulated, ready to be milked */
  honeydew: number;
  /** ant currently stroking it */
  tenderId: number | null;
  phase: number;
}

export interface Debris {
  id: number;
  x: number;
  y: number;
  carriedById: number | null;
  size: number;
}

export interface WaterDroplet {
  id: number;
  x: number;
  y: number;
  vy: number;
  radius: number;
  volume: number;
  settled: boolean;
}

export interface Chamber {
  id: number;
  type: ChamberType;
  x: number;
  y: number;
  rx: number;
  ry: number;
}

export interface Intruder {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  hp: number;
  maxHp: number;
  legPhase: number;
  species: 'mite' | 'beetle' | 'centipede' | 'earwig' | 'rival_ant';
  aggression: number; // >0 raiding entrance/tunnels, 0 retreating
  attackCooldown: number;
  behavior?: 'raiding_food' | 'hunting_ants' | 'infiltrating_brood' | 'retreating';
  carryingFoodAmount?: number;
  targetFoodId?: number | null;
  homeEdge?: 'left' | 'right';
  path?: Vec2[];
  pathIndex?: number;
  lastPathTime?: number;
  age?: number;
  /** has left the home crevice at least once (so it can't 'escape' the moment it spawns) */
  roamed?: boolean;
}

export interface FallenAnt {
  id: number;
  x: number;
  y: number;
  angle: number;
  carriedByAntId: number | null;
  atMidden: boolean;
  decayTimer: number;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
  life: number;
  maxLife: number;
  kind: 'dust' | 'mist' | 'crumb' | 'spark' | 'rain' | 'fog' | 'snow';
  color: string;
}

export interface PlantSprout {
  x: number;
  y: number;
  height: number;
  swayPhase: number;
  kind: 'moss' | 'clover' | 'fern' | 'grass';
  shade: number;
}

export interface SurfaceProp {
  kind: 'bark' | 'stone' | 'leaf' | 'outcrop';
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  seed: number;
}

export interface CameraState {
  x: number;
  y: number;
  zoom: number;
  targetX: number;
  targetY: number;
  targetZoom: number;
}
