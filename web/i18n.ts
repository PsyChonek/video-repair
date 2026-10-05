import type { RepairErrorCode, RepairMode, WarningCode } from '../src/core/repair.ts';

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
  optionsTitle: string;
  referenceLabel: string;
  referenceHint: string;
  referenceClear: string;
  modeLabel: string;
  modes: Record<RepairMode, string>;
  fpsLabel: string;
  fpsHint: string;
  audioLabel: string;
  tailLabel: string;
  syncLabel: string;
  stage: Record<Stage, string>;
  resultTitle: string;
  method: { nidx: string; scan: string };
  codecs: { h264: string; hevc: string };
  labels: { method: string; codec: string; video: string; audio: string; duration: string; recovered: string };
  frames: (n: string, keys: string) => string;
  audioFrames: (n: string) => string;
  noAudio: string;
  tail: (v: string, a: string) => string;
  download: string;
  retry: string;
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
    'Opravte zdarma MP4 video z autokamery nebo telefonu, které se nepřehraje po výpadku napájení. Oprava běží přímo v prohlížeči, soubor nikam neodesíláme.',
  skip: 'Přeskočit na obsah',
  h1: 'Oprava poškozeného MP4 videa z autokamery',
  lead: 'Kamera přišla o napájení a video nejde přehrát? Chybí mu jen index. Ten obnovíme přímo ve vašem prohlížeči, zdarma a bez přepočítání obrazu.',
  privacy: 'Soubor nikam neodesíláme. Celá oprava probíhá ve vašem zařízení.',
  pick: 'Vyberte nebo přetáhněte soubor MP4',
  pickHint: 'Funguje i se soubory o velikosti několika GB.',
  optionsTitle: 'Další možnosti opravy',
  referenceLabel: 'Funkční video ze stejné kamery (nepovinné)',
  referenceHint: 'Pomůže u telefonů, akčních kamer a souborů, kterým chybí nastavení kodeku. Stačí jakékoli jiné video, které se přehraje.',
  referenceClear: 'Odebrat',
  modeLabel: 'Způsob opravy',
  modes: {
    auto: 'Automaticky (doporučeno)',
    index: 'Jen podle indexu kamery',
    scan: 'Prohledat data videa (jen obraz)',
  },
  fpsLabel: 'Snímková frekvence',
  fpsHint: 'Prázdné = automaticky. Vyplňte, pokud se video přehrává zrychleně nebo zpomaleně.',
  audioLabel: 'Zachovat zvuk',
  tailLabel: 'Dohledat poslední sekundu za indexem',
  syncLabel: 'Srovnat časování obrazu podle zvuku',
  stage: {
    index: 'Hledám index kamery',
    verify: 'Ověřuji snímky',
    scan: 'Prohledávám data videa',
    write: 'Sestavuji opravený soubor',
  },
  resultTitle: 'Video je opravené',
  method: { nidx: 'index kamery', scan: 'prohledání dat (jen obraz)' },
  codecs: { h264: 'H.264', hevc: 'H.265 (HEVC)' },
  labels: { method: 'Metoda', codec: 'Kodek', video: 'Obraz', audio: 'Zvuk', duration: 'Délka', recovered: 'Dohledáno za indexem' },
  frames: (n, keys) => `${n} snímků (${keys} klíčových)`,
  audioFrames: (n) => `${n} rámců AAC`,
  noAudio: 'bez zvuku',
  tail: (v, a) => `${v} snímků obrazu a ${a} rámců zvuku`,
  download: 'Stáhnout opravené video',
  retry: 'Opravit znovu s těmito možnostmi',
  another: 'Opravit další soubor',
  preview: 'Náhled opraveného videa',
  warnings: {
    'file-has-moov': 'Soubor už index obsahuje. Pokud se přesto nepřehraje, opravená verze by měla pomoci.',
    'no-index-video-only': 'Kamera nezapsala vlastní index, obnovili jsme jen obraz bez zvuku.',
    'dropped-invalid-entries': 'Několik poškozených záznamů jsme vynechali.',
    'timing-from-audio': 'Kamera ztrácela snímky, časování obrazu jsme srovnali podle zvuku.',
    'codec-from-reference': 'Nastavení kodeku jsme převzali z funkčního videa.',
  },
  errors: {
    'no-video-found': 'V souboru jsme nenašli žádná použitelná video data.',
    'no-codec-config':
      'Soubor neobsahuje nastavení kodeku. Přidejte v dalších možnostech funkční video ze stejné kamery nebo telefonu a opravte znovu.',
    'no-camera-index': 'Soubor nemá index kamery. Zvolte způsob opravy Automaticky nebo Prohledat data videa.',
    'bad-reference': 'Funkční video se nepodařilo přečíst. Vyberte jiné video ze stejné kamery, které se přehraje.',
    unknown: 'Při opravě nastala neočekávaná chyba.',
  },
  howTitle: 'Jak to funguje',
  how: [
    'MP4 soubor ukládá obraz a zvuk průběžně, ale index (atom moov) zapisuje až na konci nahrávání. Když kamera přijde o napájení, index chybí a přehrávač soubor odmítne.',
    'Většina autokamer s čipem Novatek (LAMAX, Viofo, 70mai, Garmin a další) zapisuje každou sekundu malý pomocný index. Z něj sestavíme přesný nový index včetně zvuku.',
    'U ostatních kamer najdeme snímky přímo v datech videa. Pokud soubor neobsahuje nastavení kodeku (typicky telefony), převezmeme ho z funkčního videa ze stejného zařízení.',
    'Data obrazu nepřepočítáváme, opravené video je bit po bitu stejné jako to, co kamera nahrála.',
  ],
  faqTitle: 'Časté dotazy',
  faq: [
    ['Je to opravdu zdarma?', 'Ano. Bez registrace, bez vodoznaku, bez limitu velikosti. Zdrojový kód je veřejný.'],
    ['Nahrávám video na server?', 'Ne. Oprava probíhá v prohlížeči a soubor neopustí váš počítač ani telefon.'],
    ['Které kamery jsou podporované?', 'Kodeky H.264 i H.265. Kamery s čipem Novatek včetně zvuku, ostatní zařízení bez zvuku.'],
    ['Oprava hlásí chybějící nastavení kodeku. Co s tím?', 'V dalších možnostech přidejte jakékoli funkční video ze stejné kamery nebo telefonu a spusťte opravu znovu.'],
  ],
  footer: 'video-repair, svobodný software pro opravu videí z autokamer.',
};

const en: Messages = {
  title: 'Repair a corrupted dashcam MP4 for free | video-repair',
  description:
    'Free repair for dashcam and phone MP4 videos that will not play after a power cut. Runs in your browser, your file is never uploaded.',
  skip: 'Skip to content',
  h1: 'Repair a corrupted dashcam MP4 video',
  lead: 'Did the camera lose power and the video will not play? It is only missing its index. We rebuild it right in your browser, free and without re-encoding.',
  privacy: 'Your file is never uploaded. The whole repair runs on your device.',
  pick: 'Choose or drop an MP4 file',
  pickHint: 'Works with multi-GB files too.',
  optionsTitle: 'More repair options',
  referenceLabel: 'A working video from the same camera (optional)',
  referenceHint: 'Helps with phones, action cameras and files missing their codec settings. Any other video from the same device that plays is fine.',
  referenceClear: 'Remove',
  modeLabel: 'Repair method',
  modes: {
    auto: 'Automatic (recommended)',
    index: 'Camera index only',
    scan: 'Scan the video data (picture only)',
  },
  fpsLabel: 'Frame rate',
  fpsHint: 'Leave empty for automatic. Set it if the video plays too fast or too slow.',
  audioLabel: 'Keep audio',
  tailLabel: 'Recover the last second after the index',
  syncLabel: 'Align video timing to the audio',
  stage: {
    index: 'Looking for the camera index',
    verify: 'Verifying frames',
    scan: 'Scanning video data',
    write: 'Building the repaired file',
  },
  resultTitle: 'Your video is repaired',
  method: { nidx: 'camera index', scan: 'data scan (picture only)' },
  codecs: { h264: 'H.264', hevc: 'H.265 (HEVC)' },
  labels: { method: 'Method', codec: 'Codec', video: 'Video', audio: 'Audio', duration: 'Duration', recovered: 'Recovered after index' },
  frames: (n, keys) => `${n} frames (${keys} keyframes)`,
  audioFrames: (n) => `${n} AAC frames`,
  noAudio: 'no audio',
  tail: (v, a) => `${v} video and ${a} audio frames`,
  download: 'Download repaired video',
  retry: 'Repair again with these options',
  another: 'Repair another file',
  preview: 'Preview of the repaired video',
  warnings: {
    'file-has-moov': 'This file already has an index. If it still does not play, the repaired copy should.',
    'no-index-video-only': 'The camera wrote no index of its own, so only the picture was recovered, without sound.',
    'dropped-invalid-entries': 'A few damaged entries were skipped.',
    'timing-from-audio': 'The camera dropped frames, so video timing was aligned to the audio.',
    'codec-from-reference': 'Codec settings were taken from the working video.',
  },
  errors: {
    'no-video-found': 'No usable video data was found in this file.',
    'no-codec-config':
      'This file has no codec settings. Add a working video from the same camera or phone under More repair options and repair again.',
    'no-camera-index': 'This file has no camera index. Choose the Automatic or Scan method instead.',
    'bad-reference': 'The working video could not be read. Pick another video from the same camera that plays.',
    unknown: 'Something unexpected went wrong during the repair.',
  },
  howTitle: 'How it works',
  how: [
    'An MP4 file stores video and audio as it records, but writes the index (the moov atom) only at the end. When the camera loses power, the index is missing and players reject the file.',
    'Most dashcams with a Novatek chip (LAMAX, Viofo, 70mai, Garmin and more) write a small helper index every second. We use it to build an exact new index, audio included.',
    'For other cameras we find the frames in the video data itself. If the file has no codec settings (typical for phones), we take them from a working video from the same device.',
    'Nothing is re-encoded: the repaired video is bit-for-bit what the camera recorded.',
  ],
  faqTitle: 'FAQ',
  faq: [
    ['Is it really free?', 'Yes. No sign-up, no watermark, no size limit. The source code is public.'],
    ['Is my video uploaded?', 'No. The repair runs in your browser and the file never leaves your computer or phone.'],
    ['Which cameras are supported?', 'H.264 and H.265. Novatek dashcams with sound, other devices without sound.'],
    ['The repair says codec settings are missing. What now?', 'Add any working video from the same camera or phone under More repair options and run the repair again.'],
  ],
  footer: 'video-repair, free software for repairing dashcam videos.',
};

const sk: Messages = {
  title: 'Oprava poškodeného MP4 z autokamery zadarmo | video-repair',
  description:
    'Opravte zadarmo MP4 video z autokamery alebo telefónu, ktoré sa neprehrá po výpadku napájania. Oprava beží priamo v prehliadači, súbor nikam neodosielame.',
  skip: 'Preskočiť na obsah',
  h1: 'Oprava poškodeného MP4 videa z autokamery',
  lead: 'Kamera prišla o napájanie a video nejde prehrať? Chýba mu len index. Ten obnovíme priamo vo vašom prehliadači, zadarmo a bez prepočítania obrazu.',
  privacy: 'Súbor nikam neodosielame. Celá oprava prebieha vo vašom zariadení.',
  pick: 'Vyberte alebo pretiahnite súbor MP4',
  pickHint: 'Funguje aj so súbormi s veľkosťou niekoľko GB.',
  optionsTitle: 'Ďalšie možnosti opravy',
  referenceLabel: 'Funkčné video z rovnakej kamery (nepovinné)',
  referenceHint: 'Pomôže pri telefónoch, akčných kamerách a súboroch, ktorým chýba nastavenie kodeku. Stačí akékoľvek iné video, ktoré sa prehrá.',
  referenceClear: 'Odobrať',
  modeLabel: 'Spôsob opravy',
  modes: {
    auto: 'Automaticky (odporúčané)',
    index: 'Len podľa indexu kamery',
    scan: 'Prehľadať dáta videa (len obraz)',
  },
  fpsLabel: 'Snímková frekvencia',
  fpsHint: 'Prázdne = automaticky. Vyplňte, ak sa video prehráva zrýchlene alebo spomalene.',
  audioLabel: 'Zachovať zvuk',
  tailLabel: 'Dohľadať poslednú sekundu za indexom',
  syncLabel: 'Zarovnať časovanie obrazu podľa zvuku',
  stage: {
    index: 'Hľadám index kamery',
    verify: 'Overujem snímky',
    scan: 'Prehľadávam dáta videa',
    write: 'Zostavujem opravený súbor',
  },
  resultTitle: 'Video je opravené',
  method: { nidx: 'index kamery', scan: 'prehľadanie dát (len obraz)' },
  codecs: { h264: 'H.264', hevc: 'H.265 (HEVC)' },
  labels: { method: 'Metóda', codec: 'Kodek', video: 'Obraz', audio: 'Zvuk', duration: 'Dĺžka', recovered: 'Dohľadané za indexom' },
  frames: (n, keys) => `${n} snímok (${keys} kľúčových)`,
  audioFrames: (n) => `${n} rámcov AAC`,
  noAudio: 'bez zvuku',
  tail: (v, a) => `${v} snímok obrazu a ${a} rámcov zvuku`,
  download: 'Stiahnuť opravené video',
  retry: 'Opraviť znova s týmito možnosťami',
  another: 'Opraviť ďalší súbor',
  preview: 'Náhľad opraveného videa',
  warnings: {
    'file-has-moov': 'Súbor už index obsahuje. Ak sa napriek tomu neprehrá, opravená verzia by mala pomôcť.',
    'no-index-video-only': 'Kamera nezapísala vlastný index, obnovili sme len obraz bez zvuku.',
    'dropped-invalid-entries': 'Niekoľko poškodených záznamov sme vynechali.',
    'timing-from-audio': 'Kamera strácala snímky, časovanie obrazu sme zarovnali podľa zvuku.',
    'codec-from-reference': 'Nastavenie kodeku sme prevzali z funkčného videa.',
  },
  errors: {
    'no-video-found': 'V súbore sme nenašli žiadne použiteľné video dáta.',
    'no-codec-config':
      'Súbor neobsahuje nastavenie kodeku. Pridajte v ďalších možnostiach funkčné video z rovnakej kamery alebo telefónu a opravte znova.',
    'no-camera-index': 'Súbor nemá index kamery. Zvoľte spôsob opravy Automaticky alebo Prehľadať dáta videa.',
    'bad-reference': 'Funkčné video sa nepodarilo prečítať. Vyberte iné video z rovnakej kamery, ktoré sa prehrá.',
    unknown: 'Pri oprave nastala neočakávaná chyba.',
  },
  howTitle: 'Ako to funguje',
  how: [
    'MP4 súbor ukladá obraz a zvuk priebežne, ale index (atóm moov) zapisuje až na konci nahrávania. Keď kamera príde o napájanie, index chýba a prehrávač súbor odmietne.',
    'Väčšina autokamier s čipom Novatek (LAMAX, Viofo, 70mai, Garmin a ďalšie) zapisuje každú sekundu malý pomocný index. Z neho zostavíme presný nový index vrátane zvuku.',
    'Pri ostatných kamerách nájdeme snímky priamo v dátach videa. Ak súbor neobsahuje nastavenie kodeku (typicky telefóny), prevezmeme ho z funkčného videa z rovnakého zariadenia.',
    'Dáta obrazu neprepočítavame, opravené video je bit po bite rovnaké ako to, čo kamera nahrala.',
  ],
  faqTitle: 'Časté otázky',
  faq: [
    ['Je to naozaj zadarmo?', 'Áno. Bez registrácie, bez vodoznaku, bez limitu veľkosti. Zdrojový kód je verejný.'],
    ['Nahrávam video na server?', 'Nie. Oprava prebieha v prehliadači a súbor neopustí váš počítač ani telefón.'],
    ['Ktoré kamery sú podporované?', 'Kodeky H.264 aj H.265. Kamery s čipom Novatek vrátane zvuku, ostatné zariadenia bez zvuku.'],
    ['Oprava hlási chýbajúce nastavenie kodeku. Čo s tým?', 'V ďalších možnostiach pridajte akékoľvek funkčné video z rovnakej kamery alebo telefónu a spustite opravu znova.'],
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
