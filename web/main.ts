import { blobReader, cachedReader } from '../src/core/reader.ts';
import { planRepair, RepairError, type RepairMode, type RepairOptions, type RepairPlan } from '../src/core/repair.ts';
import { detectLocale, MESSAGES, type Locale } from './i18n.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  file: $<HTMLInputElement>('file'),
  drop: $<HTMLLabelElement>('drop'),
  options: $<HTMLDetailsElement>('options'),
  reference: $<HTMLInputElement>('reference'),
  referenceClear: $<HTMLButtonElement>('reference-clear'),
  mode: $<HTMLSelectElement>('mode'),
  fps: $<HTMLInputElement>('fps'),
  audio: $<HTMLInputElement>('audio'),
  tail: $<HTMLInputElement>('tail'),
  sync: $<HTMLInputElement>('sync'),
  progress: $<HTMLDivElement>('progress'),
  stage: $<HTMLSpanElement>('stage'),
  bar: $<HTMLProgressElement>('bar'),
  status: $<HTMLParagraphElement>('status'),
  error: $<HTMLDivElement>('error'),
  errorText: $<HTMLParagraphElement>('error-text'),
  errorRetry: $<HTMLButtonElement>('error-retry'),
  result: $<HTMLElement>('result'),
  report: $<HTMLDListElement>('report'),
  warnings: $<HTMLUListElement>('warnings'),
  download: $<HTMLAnchorElement>('download'),
  retry: $<HTMLButtonElement>('retry'),
  another: $<HTMLButtonElement>('another'),
  preview: $<HTMLVideoElement>('preview'),
};

const locale: Locale = detectLocale();
const t = MESSAGES[locale];
const numbers = new Intl.NumberFormat(locale);
let outputUrl: string | null = null;
let currentFile: File | null = null;
let busy = false;

function applyLocale(): void {
  document.documentElement.lang = locale;
  document.title = t.title;
  document.querySelector('meta[name="description"]')?.setAttribute('content', t.description);
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const value = t[el.dataset.i18n as keyof typeof t];
    if (typeof value === 'string') el.textContent = value;
  }
  for (const option of els.mode.options) option.textContent = t.modes[option.value as RepairMode];
  $('how').replaceChildren(...t.how.map((text) => Object.assign(document.createElement('p'), { textContent: text })));
  $('faq').replaceChildren(
    ...t.faq.map(([q, a]) => {
      const details = document.createElement('details');
      details.append(Object.assign(document.createElement('summary'), { textContent: q }), Object.assign(document.createElement('p'), { textContent: a }));
      return details;
    }),
  );
  els.preview.setAttribute('aria-label', t.preview);
  for (const link of document.querySelectorAll<HTMLAnchorElement>('nav a')) {
    if (link.hreflang === locale) link.setAttribute('aria-current', 'true');
  }
}

function readOptions(): RepairOptions {
  const fps = Number(els.fps.value);
  const reference = els.reference.files?.[0];
  return {
    mode: els.mode.value as RepairMode,
    fps: els.fps.value && fps > 0 ? fps : undefined,
    audio: els.audio.checked,
    tail: els.tail.checked,
    syncToAudio: els.sync.checked,
    reference: reference ? cachedReader(blobReader(reference)) : undefined,
  };
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const s = String(total % 60).padStart(2, '0');
  const m = Math.floor(total / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function setStage(stage: keyof typeof t.stage, fraction: number): void {
  const label = t.stage[stage];
  if (els.stage.textContent !== label) {
    els.stage.textContent = label;
    els.status.textContent = label;
  }
  els.bar.value = fraction;
}

function clearOutput(): void {
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  outputUrl = null;
  els.preview.removeAttribute('src');
  els.preview.load();
  els.result.hidden = true;
  els.error.hidden = true;
  els.progress.hidden = true;
}

function showReport(plan: RepairPlan): void {
  const r = plan.report;
  const rows: [string, string][] = [
    [t.labels.method, t.method[r.method]],
    [t.labels.codec, t.codecs[r.codec]],
    [t.labels.video, `${r.width}×${r.height}, ${numbers.format(Math.round(r.fps * 100) / 100)} fps, ${t.frames(numbers.format(r.videoFrames), numbers.format(r.keyframes))}`],
    [t.labels.audio, r.audioFrames ? t.audioFrames(numbers.format(r.audioFrames)) : t.noAudio],
    [t.labels.duration, formatDuration(r.durationSeconds)],
  ];
  if (r.tailVideoFrames || r.tailAudioFrames) {
    rows.push([t.labels.recovered, t.tail(numbers.format(r.tailVideoFrames), numbers.format(r.tailAudioFrames))]);
  }
  els.report.replaceChildren(
    ...rows.flatMap(([k, v]) => [Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v })]),
  );
  els.warnings.replaceChildren(...r.warnings.map((w) => Object.assign(document.createElement('li'), { textContent: t.warnings[w] })));
}

async function repair(file: File): Promise<void> {
  if (busy) return;
  busy = true;
  currentFile = file;
  clearOutput();
  els.progress.hidden = false;
  setStage('index', 0);
  try {
    const plan = await planRepair(cachedReader(blobReader(file)), { ...readOptions(), onProgress: setStage });
    setStage('write', 1);
    // A Blob made of the header and a slice of the original File is assembled
    // lazily by the browser, so even multi-GB outputs cost no extra memory.
    const output = new Blob([plan.header as BlobPart, file.slice(plan.dataStart, plan.dataEnd)], { type: 'video/mp4' });
    outputUrl = URL.createObjectURL(output);
    els.download.href = outputUrl;
    els.download.download = `${file.name.replace(/\.[^.]+$/, '')}_fixed.mp4`;
    els.preview.src = outputUrl;
    showReport(plan);
    els.progress.hidden = true;
    els.result.hidden = false;
    els.status.textContent = t.resultTitle;
    els.result.focus();
  } catch (err) {
    els.progress.hidden = true;
    els.errorText.textContent = err instanceof RepairError ? t.errors[err.code] : t.errors.unknown;
    els.error.hidden = false;
    if (err instanceof RepairError && (err.code === 'no-codec-config' || err.code === 'bad-reference')) {
      // The fix is in the options panel: open it and put the reference picker in focus.
      els.options.open = true;
      els.reference.focus();
    } else if (!(err instanceof RepairError)) {
      console.error(err);
    }
  } finally {
    busy = false;
  }
}

function retry(): void {
  if (currentFile) void repair(currentFile);
}

applyLocale();
els.file.addEventListener('change', () => {
  const file = els.file.files?.[0];
  if (file) void repair(file);
});
els.drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  els.drop.classList.add('over');
});
els.drop.addEventListener('dragleave', () => els.drop.classList.remove('over'));
els.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  els.drop.classList.remove('over');
  const file = e.dataTransfer?.files[0];
  if (file) void repair(file);
});
els.reference.addEventListener('change', () => {
  els.referenceClear.hidden = !els.reference.files?.length;
});
els.referenceClear.addEventListener('click', () => {
  els.reference.value = '';
  els.referenceClear.hidden = true;
  els.reference.focus();
});
els.retry.addEventListener('click', retry);
els.errorRetry.addEventListener('click', retry);
els.another.addEventListener('click', () => {
  clearOutput();
  currentFile = null;
  els.file.value = '';
  els.file.focus();
});
