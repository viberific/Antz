import { AntCaste, AntTask, ChamberType, CreatureKind, Intruder, PayloadType } from './types';

/**
 * Field notes: the natural history behind what the colony is doing.
 *
 * Every entry is written the way a documentary narrator or a museum label would put it: what the animal is,
 * what it is doing, and the real biology behind the behaviour. The simulated colony is a composite of several
 * species (seed harvesters, leaf-cutters, aphid-milkers), so notes describe the behaviour as documented in
 * ants generally and name a genus only where the finding comes from a particular one.
 */

export interface Note {
  /** the behaviour in plain words, e.g. "Following a scent trail" */
  title: string;
  /** the scientific term, shown as a small tag */
  term?: string;
  /** one or two sentences of real biology */
  body: string;
  /** how interesting this is to look at: drives which ant is picked next */
  interest: number;
}

export interface CasteNote {
  kicker: string;
  /** one-line natural history of the caste, used when nothing else is going on */
  body: string;
  accent: string;
}

export const CASTE_NOTES: Record<AntCaste, CasteNote> = {
  [AntCaste.QUEEN]: {
    kicker: 'Queen',
    accent: '#e9c46a',
    body:
      'The colony’s only egg-layer. She mated once, on her nuptial flight, and stores that sperm for the rest of her life, rationing it to fertilise each egg. In many species a queen lives for more than a decade; the oldest recorded, a Lasius niger, reached 28.',
  },
  [AntCaste.WORKER]: {
    kicker: 'Forager worker',
    accent: '#e76f51',
    body:
      'Workers are sterile females. Most species show age polyethism: young workers stay in the nest as nurses, and only the older ones take the risks of foraging outside.',
  },
  [AntCaste.NURSE]: {
    kicker: 'Nurse worker',
    accent: '#8ecae6',
    body:
      'Young adult workers spend their first weeks inside the nest caring for the brood. As they age they shift outward, from nursery to granary to foraging.',
  },
  [AntCaste.EXCAVATOR]: {
    kicker: 'Excavator worker',
    accent: '#bc8a5f',
    body:
      'Diggers work the soil with their mandibles, packing it into pellets and carrying it out one load at a time. A single mature nest can move many kilograms of earth.',
  },
  [AntCaste.SOLDIER]: {
    kicker: 'Soldier',
    accent: '#d62828',
    body:
      'In species with a size-varying worker caste, soldiers have oversized heads packed with mandible muscle. They guard the entrance, and some also crush seeds too hard for smaller workers.',
  },
  [AntCaste.GYNE]: {
    kicker: 'Gyne · virgin queen',
    accent: '#c77dff',
    body:
      'A winged, unmated future queen. Gynes are reared once a colony is large and well fed, and leave on a mating flight. After mating she tears off her own wings and digs a chamber to found a new colony alone.',
  },
  [AntCaste.MALE]: {
    kicker: 'Male · drone',
    accent: '#7ae582',
    body:
      'Males hatch from unfertilised eggs, so they have only one set of chromosomes. They do no work, live a few weeks at most, and die soon after mating.',
  },
};

const T = AntTask;

/** Behaviour notes keyed by what the ant is doing. */
export const TASK_NOTES: Partial<Record<AntTask, Note>> = {
  [T.IDLE]: {
    title: 'Resting',
    body: 'Even in a busy colony, a large share of workers are inactive at any moment. Ants rest in short bouts through the day, and this reserve of labour can be called on when demand suddenly rises.',
    interest: 0.15,
  },
  [T.FORAGING_SCOUT]: {
    title: 'Scouting for food',
    term: 'Path integration',
    body: 'A scout wanders in loops until it finds something. Ants keep a running tally of distance and direction, using step counting and the angle of the sun, so a straight line home is always known.',
    interest: 1.2,
  },
  [T.FOLLOWING_FOOD_TRAIL]: {
    title: 'Following a scent trail',
    term: 'Trail pheromone',
    body: 'Antennae sweep the ground to read a chemical path laid by earlier ants. The scent evaporates within minutes, so a trail to an emptied food source fades away unless nestmates keep reinforcing it.',
    interest: 1.5,
  },
  [T.RETURNING_WITH_FOOD]: {
    title: 'Carrying food home',
    term: 'Positive feedback',
    body: 'A laden forager lays pheromone on the way back, more of it for richer finds. Traffic builds on the best source, and the colony settles on it without any ant making a decision for the group.',
    interest: 1.5,
  },
  [T.STORING_FOOD]: {
    title: 'Stocking the granary',
    body: 'Harvester colonies keep seeds in dry underground chambers. Stored seeds can last for months, carrying the colony through winter and drought.',
    interest: 1.0,
  },
  [T.TENDING_QUEEN]: {
    title: 'Attending the queen',
    term: 'Queen pheromone',
    body: 'Attendants lick, feed and groom the queen and carry her eggs away. Her body chemistry advertises that she is fertile, and workers read it to know the colony still has a mother.',
    interest: 2.0,
  },
  [T.FEEDING_LARVA]: {
    title: 'Feeding a larva',
    body: 'Larvae are legless grubs that cannot feed themselves. Nurses offer liquid food mouth to mouth or set solid scraps beside them. How well a larva is fed can decide whether it grows into a worker or a queen.',
    interest: 2.2,
  },
  [T.MOVING_BROOD]: {
    title: 'Relocating the brood',
    body: 'Eggs, larvae and pupae are shuttled between chambers to keep them at the right temperature and humidity: nearer the warm surface by day, deeper when it is cold or dry.',
    interest: 2.0,
  },
  [T.EXCAVATING]: {
    title: 'Excavating a tunnel',
    term: 'Self-organisation',
    body: 'No ant holds a blueprint. Each digger responds to local cues, such as soil texture and the presence of other diggers, and a branching network of tunnels emerges from thousands of small decisions.',
    interest: 1.8,
  },
  [T.CARRYING_SOIL]: {
    title: 'Hauling out soil',
    body: 'Each pellet is carried up and dropped at the entrance. Over weeks the pellets build the crater-shaped mound typical of many ground-nesting species, which also warms in the sun and helps incubate the brood.',
    interest: 1.4,
  },
  [T.TROPHALLAXIS]: {
    title: 'Sharing food mouth to mouth',
    term: 'Trophallaxis',
    body: 'One ant regurgitates liquid from its crop, its “social stomach”, to another. The exchange passes along not only food but also hormones and chemical signals, linking the whole colony into one shared gut.',
    interest: 2.4,
  },
  [T.PATROLLING]: {
    title: 'Guarding the entrance',
    term: 'Nestmate recognition',
    body: 'Guards touch antennae to each ant that approaches to read its surface hydrocarbons, a colony-specific odour. Nestmates are admitted at once; strangers are challenged.',
    interest: 1.6,
  },
  [T.DEFENDING]: {
    title: 'Repelling an intruder',
    term: 'Alarm pheromone',
    body: 'A defender bites, stings or sprays formic acid, depending on the group it belongs to. It also releases alarm pheromone that draws nestmates to the spot within seconds.',
    interest: 3.2,
  },
  [T.NECROPHORESIS]: {
    title: 'Clearing refuse',
    term: 'Necrophoresis',
    body: 'As a dead ant decays it gives off fatty acids such as oleic acid, which living ants recognise as a cue to carry it away. Researchers have shown that a live ant dabbed with the chemical is carried off too.',
    interest: 1.8,
  },
  [T.LAYING_EGG]: {
    title: 'Laying an egg',
    term: 'Haplodiploidy',
    body: 'An egg the queen fertilises becomes a female; one she leaves unfertilised becomes a male. The queen controls the sex of each egg, and mature queens of some species lay hundreds of eggs a day.',
    interest: 3.0,
  },
  [T.DRINKING_DEW]: {
    title: 'Collecting moisture',
    body: 'Ants drink into their crop and carry water back to the nest, where it is shared by mouth. In dry spells, dew and condensation can be a vital water source.',
    interest: 1.2,
  },
  [T.GREETING]: {
    title: 'Antennal greeting',
    term: 'Cuticular hydrocarbons',
    body: 'Two ants meet and sample each other’s antennae. The brief contact identifies a nestmate by odour, and the rate of such encounters also tells a worker how many others are working nearby.',
    interest: 1.3,
  },
  [T.GROOMING]: {
    title: 'Grooming',
    body: 'An ant cleans its antennae by drawing them through a notched comb on the foreleg, then licks the rest of its body. It also spreads secretions from a gland on its flank that slow the growth of microbes.',
    interest: 0.9,
  },
  [T.FLEEING]: {
    title: 'Evading a threat',
    body: 'Not every ant stands and fights. Smaller or less aggressive workers flee, and some species rely on speed and alarm signals rather than weapons.',
    interest: 1.4,
  },
  [T.SIGNALING_FOOD]: {
    title: 'Recruiting nestmates',
    term: 'Recruitment',
    body: 'A forager that has found a rich source goes back and rouses others, by laying a trail, or in some species by antennal contact. The richer the find, the more strongly it recruits.',
    interest: 2.0,
  },
  [T.TENDING_FUNGUS]: {
    title: 'Tending the fungus garden',
    term: 'Fungus farming',
    body: 'Attine ants have farmed fungus for about 50 million years, long before humans farmed anything. Workers weed out foreign moulds and treat the garden with antibiotics made by bacteria living on their bodies.',
    interest: 2.4,
  },
  [T.SEEKING_REST]: {
    title: 'Heading home to rest',
    body: 'Foragers return underground when tired or when conditions turn against them, so the day’s heat and light shape who is on the surface.',
    interest: 0.4,
  },
  [T.EATING]: {
    title: 'Feeding from the stores',
    term: 'Infrabuccal pocket',
    body: 'Adult ants cannot swallow solid food. They squeeze it for the juice, and spit out the dry pellet that remains. The larvae digest the solids, then feed the adults in return.',
    interest: 1.2,
  },
  [T.REPAIRING]: {
    title: 'Repairing storm damage',
    body: 'After a collapse, workers clear the fallen soil and rebuild. Repair takes priority over new construction, especially when a tunnel is still in use.',
    interest: 1.8,
  },
  [T.TANDEM_LEADING]: {
    title: 'Leading a tandem run',
    term: 'Teaching',
    body: 'The leader walks only as fast as its follower can keep up, and waits whenever the follower taps its legs and abdomen. In Temnothorax rock ants this was the first documented case of teaching in an animal other than humans.',
    interest: 2.8,
  },
  [T.TANDEM_FOLLOWING]: {
    title: 'Following a tandem run',
    term: 'Teaching',
    body: 'The follower keeps its antennae on the leader’s abdomen. Each time contact is broken, the leader stops and waits, and the follower learns the route as it goes.',
    interest: 2.4,
  },
  [T.TENDING_APHIDS]: {
    title: 'Milking aphids',
    term: 'Mutualism',
    body: 'The ant strokes the aphid with its antennae, and the aphid releases a droplet of honeydew, sugary sap it has drawn from the plant. In return the ants defend the herd against ladybirds and other predators.',
    interest: 2.6,
  },
  [T.HUSKING_SEED]: {
    title: 'Husking seeds',
    body: 'Seed-harvesting ants strip off the outer husk before storage. Cleaning the seed helps it stay dry and keeps it from sprouting or going mouldy in the granary.',
    interest: 1.4,
  },
  [T.CARRYING_CHAFF]: {
    title: 'Carrying chaff to the midden',
    term: 'Waste management',
    body: 'Ants keep refuse in a dedicated chamber or outside the nest, well away from the brood. Separating waste from living space is one of the ways large colonies limit disease.',
    interest: 1.2,
  },
  [T.REPLETE]: {
    title: 'A living storage jar',
    term: 'Replete',
    body: 'Repletes, found in honeypot ants, are workers whose crops swell with liquid food until the abdomen is the size of a grape. They hang from the chamber ceiling and regurgitate on demand when food is scarce.',
    interest: 2.8,
  },
  [T.ALLOGROOMING]: {
    title: 'Grooming a nestmate',
    term: 'Social immunity',
    body: 'Licking a nestmate removes dirt and fungal spores before they can germinate, and spreads the shared colony odour. Colonies that groom each other have measurably lower infection rates.',
    interest: 1.8,
  },
  [T.HELPING_ECLOSION]: {
    title: 'Helping a young adult emerge',
    term: 'Eclosion',
    body: 'A newly emerged ant, called a callow, is pale and soft. Nurses tear open the cocoon and help it out, and over the next days its cuticle hardens and darkens.',
    interest: 3.2,
  },
  [T.RESCUING]: {
    title: 'Digging out a nestmate',
    term: 'Rescue behaviour',
    body: 'Rescue of trapped or buried nestmates has been documented in several species, including the desert ant Cataglyphis cursor. Rescuers dig, pull and bite at whatever holds the victim.',
    interest: 3.4,
  },
  [T.BURIED]: {
    title: 'Buried in a cave-in',
    term: 'Stridulation',
    body: 'A buried ant scrapes ridged segments of its body together, a squeak too faint for us to hear but one that nestmates feel through the soil. Leaf-cutter ants were the first species shown to call for help this way.',
    interest: 3.4,
  },
  [T.CARRYING_NESTMATE]: {
    title: 'Carrying a nestmate',
    term: 'Transport posture',
    body: 'The carried ant goes limp and curls up, folding legs and antennae against its body. The reflex makes it compact and easy to carry, and is triggered by the carrier’s grip.',
    interest: 2.6,
  },
  [T.BEING_CARRIED]: {
    title: 'Being carried',
    term: 'Transport posture',
    body: 'Held in the carrier’s jaws, the passenger curls up and goes still. The reflex is triggered by the grip alone, and it shortens the journey for an ant that is hurt or being moved to a new nest.',
    interest: 1.8,
  },
  [T.GROUP_TRANSPORT]: {
    title: 'Hauling prey together',
    term: 'Cooperative transport',
    body: 'Ants can move loads many times heavier than any single worker could lift. Each ant adjusts its pull according to the forces it feels through the load itself, and the group steers as one.',
    interest: 3.0,
  },
  [T.CLEARING_TRAIL]: {
    title: 'Clearing the trail',
    body: 'On busy routes, workers carry away twigs and grit that slow the traffic. Leaf-cutter ants maintain long trunk trails this way, much as road crews do.',
    interest: 1.5,
  },
  [T.CANNIBALIZING]: {
    title: 'Eating eggs in a famine',
    term: 'Brood cannibalism',
    body: 'When food runs short, colonies recycle their young. Eggs and small larvae are the first to go, and their nutrients keep the older brood and the queen alive until food returns.',
    interest: 2.8,
  },
  [T.NUPTIAL_FLIGHT]: {
    title: 'The nuptial flight',
    term: 'Mating flight',
    body: 'On one warm, humid day, winged queens and males from many colonies take to the air at once. They mate in mid-flight, and the queen keeps the sperm of those males for life.',
    interest: 4.0,
  },
  [T.WAITING_TO_SWARM]: {
    title: 'Waiting for flying weather',
    body: 'Winged ants gather near the exits until warm, still, humid conditions arrive. Synchronised flights let colonies’ young queens meet unrelated males and swamp predators with numbers.',
    interest: 2.0,
  },
  [T.CLUSTERING]: {
    title: 'Overwintering',
    term: 'Dormancy',
    body: 'In cold climates the colony retreats below the frost line and clusters in a deep chamber. Metabolism slows, the queen stops laying, and the colony lives on stored fat for months.',
    interest: 1.4,
  },
  [T.SEALING_ENTRANCE]: {
    title: 'Sealing the entrance',
    body: 'Workers plug the entrance with soil when it is cold, wet or threatened. A sealed nest keeps rain and intruders out and holds in heat and moisture.',
    interest: 1.6,
  },
  [T.BACKFILLING]: {
    title: 'Backfilling an old gallery',
    body: 'Disused tunnels are often packed with soil. This keeps the nest compact, easier to defend and easier to keep at a stable temperature.',
    interest: 1.2,
  },
  [T.CUTTING_LEAF]: {
    title: 'Cutting a leaf',
    term: 'Leaf-cutter ants',
    body: 'The worker anchors one jaw and shears with the other, vibrating it about a thousand times a second to cut through the leaf. The fragment will not be eaten: it is compost for the colony’s fungus.',
    interest: 2.8,
  },
  [T.CARRYING_LEAF]: {
    title: 'Carrying a leaf fragment',
    body: 'Fragments often outweigh the carrier. Tiny workers sometimes ride on top, standing guard against parasitic flies that try to lay eggs on the carrier’s head.',
    interest: 2.4,
  },
};

export const PAYLOAD_LABEL: Record<number, string> = {
  [PayloadType.SEED]: 'Carrying a seed',
  [PayloadType.HONEYDEW]: 'Carrying honeydew',
  [PayloadType.PROTEIN]: 'Carrying prey',
  [PayloadType.SOIL]: 'Carrying a soil pellet',
  [PayloadType.EGG]: 'Carrying an egg',
  [PayloadType.LARVA]: 'Carrying a larva',
  [PayloadType.PUPA]: 'Carrying a pupa',
  [PayloadType.FUNGUS]: 'Carrying fungus',
  [PayloadType.REFUSE]: 'Carrying refuse',
  [PayloadType.CHAFF]: 'Carrying seed husks',
  [PayloadType.DEBRIS]: 'Carrying debris',
  [PayloadType.LEAF]: 'Carrying a leaf fragment',
};

export const PLACE_LABEL: Record<ChamberType, string> = {
  [ChamberType.ROYAL]: 'Royal chamber',
  [ChamberType.NURSERY]: 'Brood nursery',
  [ChamberType.GRANARY]: 'Granary',
  [ChamberType.FUNGUS]: 'Fungus garden',
  [ChamberType.MIDDEN]: 'Refuse midden',
};

export interface CreatureNote extends Note {
  kicker: string;
  accent: string;
}

/** Wildlife that shares the case. The `body` is shown for any state; states add a second line of what it is doing now. */
export const CREATURE_NOTES: Record<CreatureKind, CreatureNote> = {
  bird: {
    kicker: 'Predator · bird',
    title: 'A ground-feeding bird',
    term: 'Predation',
    body: 'Many small songbirds pick insects off the ground, and ants are an easy meal. Some birds even rub ants through their feathers, a habit called anting; the ants’ formic acid is thought to deter feather parasites.',
    interest: 3.4,
    accent: '#8d99ae',
  },
  spider: {
    kicker: 'Predator · spider',
    title: 'A spider’s snare',
    term: 'Silk',
    body: 'Spiders detect struggling prey by the vibrations in their silk. A few specialists, such as members of the family Zodariidae, hunt ants almost exclusively, and some other spiders mimic ants to avoid predators themselves.',
    interest: 3.0,
    accent: '#a68a64',
  },
  antlion: {
    kicker: 'Predator · antlion',
    title: 'The antlion’s pit',
    term: 'Pitfall trap',
    body: 'The larva of a lacewing-like insect digs a cone in loose sand and waits buried at the bottom. It flicks sand to knock prey down the slope, then injects digestive juices and drinks the contents.',
    interest: 3.2,
    accent: '#e0b76a',
  },
  anteater: {
    kicker: 'Predator · anteater',
    title: 'An anteater at work',
    term: 'Myrmecophagy',
    body: 'Anteaters have no teeth. A sticky tongue, up to 60 cm long in the giant anteater, flicks in and out about 150 times a minute. They feed briefly at each nest and move on, so the colony survives to be raided again.',
    interest: 3.4,
    accent: '#b08968',
  },
  worm: {
    kicker: 'Soil life · earthworm',
    title: 'An earthworm in the soil',
    term: 'Bioturbation',
    body: 'Earthworms swallow soil as they burrow, mixing and aerating it, and leave behind nutrient-rich castings. Their tunnels are not defended, so ants may reuse them or be blocked by them.',
    interest: 2.4,
    accent: '#d08c8c',
  },
  ladybug: {
    kicker: 'Visitor · ladybird',
    title: 'A ladybird among the aphids',
    term: 'Aposematism',
    body: 'The bright red wing cases warn predators that the beetle tastes foul. Ladybirds and their larvae eat thousands of aphids in their lifetime, which is why ants that tend aphids attack them.',
    interest: 2.4,
    accent: '#e5383b',
  },
};

export const INTRUDER_NOTES: Record<Intruder['species'], CreatureNote> = {
  mite: {
    kicker: 'Nest intruder · mite',
    title: 'A mite in the nest',
    term: 'Myrmecophily',
    body: 'Many mites live in and around ant nests. Some are scavengers, some parasites riding on workers, and some copy the colony odour so closely that the ants fail to notice them.',
    interest: 2.4,
    accent: '#c1121f',
  },
  beetle: {
    kicker: 'Nest intruder · beetle',
    title: 'A beetle among the ants',
    term: 'Chemical mimicry',
    body: 'Some beetles live inside ant colonies as guests or thieves. They match the colony’s chemical signature, or offer secretions that workers find irresistible, and a few eat the brood.',
    interest: 2.6,
    accent: '#ae2012',
  },
  centipede: {
    kicker: 'Nest intruder · centipede',
    title: 'A centipede hunting',
    term: 'Venom',
    body: 'Centipedes are fast predators with a pair of venom-injecting claws behind the head. They hunt by touch at night and slip into burrows after soft prey, such as ant brood.',
    interest: 3.2,
    accent: '#9b2226',
  },
  earwig: {
    kicker: 'Nest intruder · earwig',
    title: 'An earwig on patrol',
    term: 'Cerci',
    body: 'Earwigs are mostly night-time scavengers. The pincers at the end of the body are used in defence and in courtship, and a hard exoskeleton makes them a tough target for ants.',
    interest: 2.2,
    accent: '#bb3e03',
  },
  rival_ant: {
    kicker: 'Rival colony · worker',
    title: 'A rival colony’s ant',
    term: 'Territorial warfare',
    body: 'Ants from different colonies recognise one another as enemies by smell. Neighbouring colonies fight over territory and food, and the battles between them can involve hundreds or even thousands of workers.',
    interest: 3.4,
    accent: '#d00000',
  },
};

export const INTRUDER_DOING: Partial<Record<NonNullable<Intruder['behavior']>, string>> = {
  raiding_food: 'Raiding the stores',
  hunting_ants: 'Hunting ants',
  infiltrating_brood: 'Seeking the brood chamber',
  retreating: 'Retreating',
};

export const CREATURE_DOING: Record<string, string> = {
  pecking: 'Pecking at the ground',
  flying: 'In flight',
  leaving: 'Leaving',
  wrapping: 'Wrapping prey in silk',
  waiting: 'Waiting for vibrations',
  lurking: 'Lurking beneath the sand',
  flinging: 'Flicking sand at prey',
  roaming: 'Roaming',
  eating: 'Feeding',
  digging: 'Digging',
};

export interface EventNote {
  id: string;
  match: RegExp;
  kicker: string;
  title: string;
  body: string;
  accent: string;
  /** seconds before this caption may appear again */
  cooldown: number;
  /** creature kind this banner already introduces (its callout stays quiet afterwards) */
  creature?: CreatureKind;
}

/** Colony events (the sim's log lines) re-told as short natural-history captions. */
export const EVENT_NOTES: EventNote[] = [
  {
    id: 'nightfall',
    match: /^Night falls/,
    kicker: 'Daily rhythm',
    title: 'Night falls on the colony',
    body: 'Ants are cold-blooded, so as the ground cools their muscles and metabolism slow. Most species withdraw underground and cluster in the warmest chambers; a few, in hot climates, switch to foraging after dark.',
    accent: '#7b8cde',
    cooldown: 600,
  },
  {
    id: 'dawn',
    match: /dawns: foragers stream out/,
    kicker: 'Daily rhythm',
    title: 'Foragers head out at dawn',
    body: 'Surface activity follows soil temperature. As the ground warms, scouts leave first, and the trails they lay recruit the rest of the foraging force.',
    accent: '#f4a261',
    cooldown: 600,
  },
  {
    id: 'rain',
    match: /Rain begins|foragers shelter|Drizzle/,
    kicker: 'Weather',
    title: 'Rain on the nest',
    body: 'Rain washes away pheromone trails and floods shallow tunnels. Foragers retreat underground, and workers move brood to higher, drier chambers.',
    accent: '#4cc9f0',
    cooldown: 240,
  },
  {
    id: 'snow',
    match: /^Snow/,
    kicker: 'Weather',
    title: 'Snow: the colony goes deep',
    body: 'Temperate ants overwinter below the frost line, clustered in a dormant, low-energy state. The queen stops laying until spring.',
    accent: '#caf0f8',
    cooldown: 400,
  },
  {
    id: 'heat',
    match: /Too hot on the surface/,
    kicker: 'Thermal limits',
    title: 'Too hot to forage',
    body: 'Soil can be far hotter than the air above it, and most ants stop foraging near 40 to 45 °C. The Saharan silver ant forages when the sand passes 60 °C, relying on sprint speed and reflective hairs.',
    accent: '#ff9f1c',
    cooldown: 400,
  },
  {
    id: 'cold',
    match: /Too cold for foraging/,
    kicker: 'Thermal limits',
    title: 'Too cold to forage',
    body: 'Below about 10 °C most temperate ants cannot move fast enough to forage safely, and they remain in the nest until it warms.',
    accent: '#90e0ef',
    cooldown: 400,
  },
  {
    id: 'war',
    match: /declared war|raiding party of rival|Wave \d|Final assault|strike back at the rival/,
    kicker: 'Territorial warfare',
    title: 'War between neighbouring colonies',
    body: 'Neighbouring colonies compete for food and ground. Ants recognise outsiders by the chemical coating on their bodies, and battles between rival nests can involve thousands of workers.',
    accent: '#e63946',
    cooldown: 150,
  },
  {
    id: 'war-end',
    match: /lost the war|beaten back/,
    kicker: 'Territorial warfare',
    title: 'The battle is over',
    body: 'A colony that loses a war may be plundered of its stores, or its brood carried off. Where the defenders hold, the boundary between the two territories is redrawn.',
    accent: '#e63946',
    cooldown: 150,
  },
  {
    id: 'bird',
    match: /^A bird swoops/,
    kicker: 'Predator',
    title: 'A bird has found the trail',
    body: 'Foraging trails advertise the colony’s location. Ground-feeding birds learn to watch busy trails, and ants respond by recruiting soldiers or retreating underground.',
    accent: '#8d99ae',
    cooldown: 300,
    creature: 'bird',
  },
  {
    id: 'spider',
    match: /^A spider spins/,
    kicker: 'Predator',
    title: 'A web beside the trail',
    body: 'A spider that settles beside an ant trail has found a reliable supply of prey. Silk lines turn the busiest ant highway into a hunting ground.',
    accent: '#a68a64',
    cooldown: 300,
    creature: 'spider',
  },
  {
    id: 'antlion',
    match: /^An antlion has dug/,
    kicker: 'Predator',
    title: 'An antlion digs its trap',
    body: 'The larva spirals backwards into loose sand, tossing it out with its head, until a cone-shaped pit remains. The angle of the slope is just steep enough to keep prey sliding.',
    accent: '#e0b76a',
    cooldown: 300,
    creature: 'antlion',
  },
  {
    id: 'anteater',
    match: /^An anteater lumbers/,
    kicker: 'Predator',
    title: 'An anteater approaches',
    body: 'An anteater smells a nest from a distance. With strong claws it opens the mound, and its tongue does the rest. It rarely stays long, since the ants’ bites and acid are painful.',
    accent: '#b08968',
    cooldown: 300,
    creature: 'anteater',
  },
  {
    id: 'worm',
    match: /^An earthworm is tunnelling/,
    kicker: 'Soil life',
    title: 'An earthworm passes through',
    body: 'Worms mix and aerate the soil and leave castings rich in nutrients. A worm burrow can cut across an ant tunnel, or serve as a ready-made passage.',
    accent: '#d08c8c',
    cooldown: 300,
    creature: 'worm',
  },
  {
    id: 'ladybird',
    match: /^A ladybird lands/,
    kicker: 'Visitor',
    title: 'A ladybird among the aphids',
    body: 'Ladybirds and their larvae are voracious aphid-eaters. Ants that milk aphids for honeydew guard the herd, attacking ladybirds and other predators.',
    accent: '#e5383b',
    cooldown: 300,
    creature: 'ladybug',
  },
  {
    id: 'nuptial',
    match: /Nuptial flight/,
    kicker: 'Reproduction',
    title: 'The nuptial flight',
    body: 'On a single warm, humid day, winged queens and males from many nests take off together. After mating, males die within days. Each fertilised queen lands, sheds her wings and digs a first chamber alone.',
    accent: '#c77dff',
    cooldown: 400,
  },
  {
    id: 'alate',
    match: /A winged .* has emerged/,
    kicker: 'Reproduction',
    title: 'A winged reproductive emerges',
    body: 'Only a well-fed colony rears gynes and males. They are fed extra and kept inside until the right weather arrives for the mating flight.',
    accent: '#c77dff',
    cooldown: 200,
  },
  {
    id: 'relocate',
    match: /moving house|no longer safe|digging a new royal chamber|settled into her new royal/,
    kicker: 'Colony decisions',
    title: 'The colony moves house',
    body: 'When a nest turns unsafe, scouts search for a better site and lead nestmates to it, often by tandem running. In rock ants, the move happens once enough scouts are present at a site, a quorum.',
    accent: '#ffd166',
    cooldown: 200,
  },
  {
    id: 'chamber',
    match: /finished a new|began digging toward a new|new side gallery|gallery tunnel was completed/,
    kicker: 'Nest architecture',
    title: 'The nest takes shape',
    body: 'Ant nests are networks of chambers linked by tunnels. Rooms for brood, food and refuse tend to sit at different depths, where temperature and humidity best suit each.',
    accent: '#bc8a5f',
    cooldown: 180,
  },
  {
    id: 'mound',
    match: /The mound keeps growing/,
    kicker: 'Nest architecture',
    title: 'The mound grows',
    body: 'Each soil pellet is dropped near the entrance. The mound is not just spoil, though: it warms quickly in the sun, giving the brood a warm place to develop.',
    accent: '#bc8a5f',
    cooldown: 400,
  },
  {
    id: 'cavein',
    match: /Caved-in|fallen-in|cave-in|crumbling|Rain washed mud|Heavy footsteps|ground trembles/,
    kicker: 'Hazards',
    title: 'The ground gives way',
    body: 'Tunnels are only as strong as the soil around them. Ants sense vibration with organs in their legs, so heavy footsteps above are felt well before any soil falls.',
    accent: '#a98467',
    cooldown: 160,
  },
  {
    id: 'plug',
    match: /plug the entrances|reopen the entrances/,
    kicker: 'Nest defence',
    title: 'Entrances sealed against the weather',
    body: 'Workers close the nest with soil when conditions are poor. A closed entrance holds in heat and moisture and keeps out rain and enemies.',
    accent: '#bc8a5f',
    cooldown: 200,
  },
  {
    id: 'rescue',
    match: /buried worker|dug a buried worker/,
    kicker: 'Rescue behaviour',
    title: 'Nestmates dig out a buried worker',
    body: 'A buried ant signals by scraping ridged body segments together; nestmates sense the vibration through the soil and dig toward it. Rescue is rare among animals.',
    accent: '#06d6a0',
    cooldown: 160,
  },
  {
    id: 'famine',
    match: /^Famine/,
    kicker: 'Colony economics',
    title: 'Famine: the brood is eaten',
    body: 'When food runs out, workers eat eggs and the smallest larvae. The nutrients are recycled into the older brood and the queen, so the colony loses some young but survives.',
    accent: '#ef476f',
    cooldown: 250,
  },
  {
    id: 'replete',
    match: /becomes a replete/,
    kicker: 'Division of labour',
    title: 'A worker becomes a living pantry',
    body: 'Honeypot ants turn some workers into storage vessels. They are fed until the abdomen swells, then hang motionless, releasing food when others come asking.',
    accent: '#ffb703',
    cooldown: 250,
  },
  {
    id: 'prey',
    match: /dragged a large insect home/,
    kicker: 'Cooperative transport',
    title: 'A team brings home large prey',
    body: 'A carcass too large to carry is cut up at the entrance. The pieces are shared among the nurses, whose larvae can digest solid protein that adults cannot.',
    accent: '#e76f51',
    cooldown: 200,
  },
  {
    id: 'theft',
    match: /stole food|raider escaped|devoured some brood/,
    kicker: 'Parasites and thieves',
    title: 'A thief in the nest',
    body: 'A colony’s stores and brood attract many uninvited guests. Some beat the defences by force, others by matching the colony’s smell.',
    accent: '#ae2012',
    cooldown: 200,
  },
  {
    id: 'defended',
    match: /Defenders killed|was driven off|fell defending/,
    kicker: 'Nest defence',
    title: 'The defenders hold the line',
    body: 'Defence is collective: an alarm pheromone from the first ants to find an enemy pulls in nestmates, and many weak attackers can overwhelm a much larger one.',
    accent: '#e63946',
    cooldown: 180,
  },
  {
    id: 'queenless',
    match: /Queenless workers/,
    kicker: 'Reproduction',
    title: 'Workers lay unfertilised eggs',
    body: 'Workers cannot mate, but they can still lay eggs. Unfertilised eggs become males, so a colony that has lost its queen produces a last generation of drones and then fades away.',
    accent: '#c77dff',
    cooldown: 400,
  },
  {
    id: 'queendead',
    match: /The queen has died/,
    kicker: 'Colony fate',
    title: 'The queen is dead',
    body: 'A colony with no queen can raise no new workers. The existing workers carry on, getting older and fewer, until the colony ends.',
    accent: '#e9c46a',
    cooldown: 600,
  },
];

/** The ant's own bearing on the story: where it is right now. */
export function lifeStage(age: number, maxAge: number, callow: boolean): string {
  if (callow) return 'Newly emerged';
  const f = maxAge > 0 ? age / maxAge : 0;
  return f < 0.25 ? 'Young adult' : f < 0.7 ? 'Mid-life' : 'Veteran';
}
