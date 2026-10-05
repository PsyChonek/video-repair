import type { RepairErrorCode, WarningCode } from '../src/core/repair.ts';

export const LOCALES = ['cs', 'en', 'sk'] as const;
export type Locale = (typeof LOCALES)[number];

type Stage = 'index' | 'verify' | 'scan' | 'write';

interface Messages {
  title: string;
  description: string;
  skip: string;
  h1: string;
  lead: string;
  privacy: string;
  pick: string;
  pickHint: string;
  stage: Record<Stage, string>;
  resultTitle: string;
  method: { nidx: string; scan: string };
  labels: { method: string; video: string; audio: string; duration: string; recovered: string };
  frames: (n: string, keys: string) => string;
  audioFrames: (n: string) => string;
  noAudio: string;
  tail: (v: string, a: string) => string;
  download: string;
  another: string;
  preview: string;
  warnings: Record<WarningCode, string>;
  errors: Record<RepairErrorCode | 'unknown', string>;
  howTitle: string;
  how: string[];
  faqTitle: string;
  faq: [string, string][];
  footer: string;
}

const cs: Messages = {
  title: 'Oprava poškozeného MP4 z autokamery zdarma | video-repair',
  description:
    'Opravte zdarma MP4 video z autokamery, které se nepřehraje po výpadku napájení. Oprava běží přímo v prohlížeči, soubor nikam neodesíláme.',
  skip: 'Přeskočit na obsah',
  h1: 'Oprava poškozeného MP4 videa z autokamery',
  lead: 'Kamera přišla o napájení a video nejde přehrát? Chybí mu jen index. Ten obnovíme přímo ve vašem prohlížeči, zdarma a bez přepočítání obrazu.',
  privacy: 'Soubor nikam neodesíláme. Celá oprava probíhá ve vašem zařízení.',
  pick: 'Vyberte nebo přetáhněte soubor MP4',
  pickHint: 'Funguje i se soubory o velikosti několika GB.',
  stage: {
    index: 'Hledám index kamery',
    verify: 'Ověřuji snímky',
    scan: 'Prohledávám data videa',
    write: 'Sestavuji opravený soubor',
  },
  resultTitle: 'Video je opravené',
  method: { nidx: 'index kamery', scan: 'prohledání dat (jen obraz)' },
  labels: { method: 'Metoda', video: 'Obraz', audio: 'Zvuk', duration: 'Délka', recovered: 'Dohledáno za indexem' },
  frames: (n, keys) => `${n} snímků (${keys} klíčových)`,
  audioFrames: (n) => `${n} rámců AAC`,
  noAudio: 'bez zvuku',
  tail: (v, a) => `${v} snímků obrazu a ${a} rámců zvuku`,
  download: 'Stáhnout opravené video',
  another: 'Opravit další soubor',
  preview: 'Náhled opraveného videa',
  warnings: {
    'file-has-moov': 'Soubor už index obsahuje. Pokud se přesto nepřehraje, opravená verze by měla pomoci.',
    'no-index-video-only': 'Kamera nezapsala vlastní index, obnovili jsme jen obraz bez zvuku.',
    'dropped-invalid-entries': 'Několik poškozených záznamů jsme vynechali.',
    'timing-from-audio': 'Kamera ztrácela snímky, časování obrazu jsme srovnali podle zvuku.',
    'unsupported-codec': 'Tento kodek zatím nepodporujeme.',
  },
  errors: {
    'no-video-found': 'V souboru jsme nenašli žádná použitelná video data.',
    'no-codec-config': 'Nenašli jsme nastavení kodeku H.264, soubor zřejmě není z podporované kamery.',
    'unsupported-codec': 'Video je v kodeku H.265/HEVC, ten zatím neumíme opravit.',
    unknown: 'Při opravě nastala neočekávaná chyba.',
  },
  howTitle: 'Jak to funguje',
  how: [
    'MP4 soubor ukládá obraz a zvuk průběžně, ale index (atom moov) zapisuje až na konci nahrávání. Když kamera přijde o napájení, index chybí a přehrávač soubor odmítne.',
    'Většina autokamer s čipem Novatek (LAMAX, Viofo, 70mai, Garmin a další) zapisuje každou sekundu malý pomocný index. Z něj sestavíme přesný nový index včetně zvuku.',
    'Data obrazu nepřepočítáváme, opravené video je bit po bitu stejné jako to, co kamera nahrála.',
  ],
  faqTitle: 'Časté dotazy',
  faq: [
    ['Je to opravdu zdarma?', 'Ano. Bez registrace, bez vodoznaku, bez limitu velikosti.'],
    ['Nahrávám video na server?', 'Ne. Oprava probíhá v prohlížeči a soubor neopustí váš počítač ani telefon.'],
    ['Které kamery jsou podporované?', 'Kamery s kodekem H.264, nejlépe s čipem Novatek. Ostatní obnovíme bez zvuku. H.265 zatím ne.'],
  ],
  footer: 'video-repair, svobodný software pro opravu videí z autokamer.',
};

const en: Messages = {
  title: 'Repair a corrupted dashcam MP4 for free | video-repair',
  description:
    'Free repair for dashcam MP4 videos that will not play after a power cut. Runs in your browser, your file is never uploaded.',
  skip: 'Skip to content',
  h1: 'Repair a corrupted dashcam MP4 video',
  lead: 'Did the camera lose power and the video will not play? It is only missing its index. We rebuild it right in your browser, free and without re-encoding.',
  privacy: 'Your file is never uploaded. The whole repair runs on your device.',
  pick: 'Choose or drop an MP4 file',
  pickHint: 'Works with multi-GB files too.',
  stage: {
    index: 'Looking for the camera index',
    verify: 'Verifying frames',
    scan: 'Scanning video data',
    write: 'Building the repaired file',
  },
  resultTitle: 'Your video is repaired',
  method: { nidx: 'camera index', scan: 'data scan (video only)' },
  labels: { method: 'Method', video: 'Video', audio: 'Audio', duration: 'Duration', recovered: 'Recovered after index' },
  frames: (n, keys) => `${n} frames (${keys} keyframes)`,
  audioFrames: (n) => `${n} AAC frames`,
  noAudio: 'no audio',
  tail: (v, a) => `${v} video and ${a} audio frames`,
  download: 'Download repaired video',
  another: 'Repair another file',
  preview: 'Preview of the repaired video',
  warnings: {
    'file-has-moov': 'This file already has an index. If it still does not play, the repaired copy should.',
    'no-index-video-only': 'The camera wrote no index of its own, so only the picture was recovered, without sound.',
    'dropped-invalid-entries': 'A few damaged entries were skipped.',
    'timing-from-audio': 'The camera dropped frames, so video timing was aligned to the audio.',
    'unsupported-codec': 'This codec is not supported yet.',
  },
  errors: {
    'no-video-found': 'No usable video data was found in this file.',
    'no-codec-config': 'No H.264 codec settings were found; the file is probably not from a supported camera.',
    'unsupported-codec': 'This video uses H.265/HEVC, which cannot be repaired yet.',
    unknown: 'Something unexpected went wrong during the repair.',
  },
  howTitle: 'How it works',
  how: [
    'An MP4 file stores video and audio as it records, but writes the index (the moov atom) only at the end. When the camera loses power, the index is missing and players reject the file.',
    'Most dashcams with a Novatek chip (LAMAX, Viofo, 70mai, Garmin and more) write a small helper index every second. We use it to build an exact new index, audio included.',
    'Nothing is re-encoded: the repaired video is bit-for-bit what the camera recorded.',
  ],
  faqTitle: 'FAQ',
  faq: [
    ['Is it really free?', 'Yes. No sign-up, no watermark, no size limit.'],
    ['Is my video uploaded?', 'No. The repair runs in your browser and the file never leaves your computer or phone.'],
    ['Which cameras are supported?', 'H.264 cameras, best with a Novatek chip. Others are recovered without sound. H.265 not yet.'],
  ],
  footer: 'video-repair, free software for repairing dashcam videos.',
};

const sk: Messages = {
  title: 'Oprava poškodeného MP4 z autokamery zadarmo | video-repair',
  description:
    'Opravte zadarmo MP4 video z autokamery, ktoré sa neprehrá po výpadku napájania. Oprava beží priamo v prehliadači, súbor nikam neodosielame.',
  skip: 'Preskočiť na obsah',
  h1: 'Oprava poškodeného MP4 videa z autokamery',
  lead: 'Kamera prišla o napájanie a video nejde prehrať? Chýba mu len index. Ten obnovíme priamo vo vašom prehliadači, zadarmo a bez prepočítania obrazu.',
  privacy: 'Súbor nikam neodosielame. Celá oprava prebieha vo vašom zariadení.',
  pick: 'Vyberte alebo pretiahnite súbor MP4',
  pickHint: 'Funguje aj so súbormi s veľkosťou niekoľko GB.',
  stage: {
    index: 'Hľadám index kamery',
    verify: 'Overujem snímky',
    scan: 'Prehľadávam dáta videa',
    write: 'Zostavujem opravený súbor',
  },
  resultTitle: 'Video je opravené',
  method: { nidx: 'index kamery', scan: 'prehľadanie dát (len obraz)' },
  labels: { method: 'Metóda', video: 'Obraz', audio: 'Zvuk', duration: 'Dĺžka', recovered: 'Dohľadané za indexom' },
  frames: (n, keys) => `${n} snímok (${keys} kľúčových)`,
  audioFrames: (n) => `${n} rámcov AAC`,
  noAudio: 'bez zvuku',
  tail: (v, a) => `${v} snímok obrazu a ${a} rámcov zvuku`,
  download: 'Stiahnuť opravené video',
  another: 'Opraviť ďalší súbor',
  preview: 'Náhľad opraveného videa',
  warnings: {
    'file-has-moov': 'Súbor už index obsahuje. Ak sa napriek tomu neprehrá, opravená verzia by mala pomôcť.',
    'no-index-video-only': 'Kamera nezapísala vlastný index, obnovili sme len obraz bez zvuku.',
    'dropped-invalid-entries': 'Niekoľko poškodených záznamov sme vynechali.',
    'timing-from-audio': 'Kamera strácala snímky, časovanie obrazu sme zarovnali podľa zvuku.',
    'unsupported-codec': 'Tento kodek zatiaľ nepodporujeme.',
  },
  errors: {
    'no-video-found': 'V súbore sme nenašli žiadne použiteľné video dáta.',
    'no-codec-config': 'Nenašli sme nastavenie kodeku H.264, súbor zrejme nie je z podporovanej kamery.',
    'unsupported-codec': 'Video je v kodeku H.265/HEVC, ten zatiaľ nevieme opraviť.',
    unknown: 'Pri oprave nastala neočakávaná chyba.',
  },
  howTitle: 'Ako to funguje',
  how: [
    'MP4 súbor ukladá obraz a zvuk priebežne, ale index (atóm moov) zapisuje až na konci nahrávania. Keď kamera príde o napájanie, index chýba a prehrávač súbor odmietne.',
    'Väčšina autokamier s čipom Novatek (LAMAX, Viofo, 70mai, Garmin a ďalšie) zapisuje každú sekundu malý pomocný index. Z neho zostavíme presný nový index vrátane zvuku.',
    'Dáta obrazu neprepočítavame, opravené video je bit po bite rovnaké ako to, čo kamera nahrala.',
  ],
  faqTitle: 'Časté otázky',
  faq: [
    ['Je to naozaj zadarmo?', 'Áno. Bez registrácie, bez vodoznaku, bez limitu veľkosti.'],
    ['Nahrávam video na server?', 'Nie. Oprava prebieha v prehliadači a súbor neopustí váš počítač ani telefón.'],
    ['Ktoré kamery sú podporované?', 'Kamery s kodekom H.264, najlepšie s čipom Novatek. Ostatné obnovíme bez zvuku. H.265 zatiaľ nie.'],
  ],
  footer: 'video-repair, slobodný softvér na opravu videí z autokamier.',
};

export const MESSAGES: Record<Locale, Messages> = { cs, en, sk };

export function detectLocale(): Locale {
  const fromUrl = new URLSearchParams(location.search).get('lang');
  const candidates = [fromUrl, ...navigator.languages].filter(Boolean) as string[];
  for (const c of candidates) {
    const base = c.slice(0, 2).toLowerCase();
    if ((LOCALES as readonly string[]).includes(base)) return base as Locale;
  }
  return 'cs';
}
