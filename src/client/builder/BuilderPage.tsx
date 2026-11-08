/**
 * Builder: suggest a change or ask a question in plain words. A coding agent on the owner's PC works
 * on it; code changes wait here for approval, and approving pushes them, which deploys them.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ImagePlus, Loader2, MessageSquareText, Plus, Send, Square } from 'lucide-react';
import type { BuilderImage, RequestStatus, RequestSummary } from '../../server/builder/types';

const POLL_MS = 3000;

const STATUS: Record<RequestStatus, { label: string; tone: string }> = {
  queued: { label: 'Waiting', tone: 'text-slate-300 bg-slate-800' },
  running: { label: 'Working', tone: 'text-cyan-200 bg-cyan-900/60' },
  proposed: { label: 'Ready for you', tone: 'text-emerald-200 bg-emerald-900/60' },
  done: { label: 'Answered', tone: 'text-slate-200 bg-slate-700' },
  merge_queued: { label: 'Going live soon', tone: 'text-fuchsia-200 bg-fuchsia-900/60' },
  merging: { label: 'Going live', tone: 'text-fuchsia-200 bg-fuchsia-900/60' },
  applied: { label: 'Live', tone: 'text-emerald-200 bg-emerald-800/60' },
  failed: { label: 'Stopped', tone: 'text-rose-200 bg-rose-900/60' },
  cancelled: { label: 'Cancelled', tone: 'text-slate-400 bg-slate-800' },
};

interface Overview {
  requests: RequestSummary[];
  workerOnline: boolean;
  spentUsd: number;
  dailyLimitUsd: number;
}

async function send(url: string, body: object): Promise<{ ok: boolean; json: { error?: string; id?: string } }> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: res.ok, json: (await res.json().catch(() => ({}))) as { error?: string; id?: string } };
}

/** Shrinks a photo to at most 1600 px on its long side, as JPEG, so uploads stay small. */
async function readPhoto(file: File): Promise<BuilderImage> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/jpeg', 0.85);
  return { mediaType: 'image/jpeg', base64: url.slice(url.indexOf(',') + 1) };
}

function Composer({ placeholder, button, onSend }: { placeholder: string; button: string; onSend: (text: string, images: BuilderImage[]) => Promise<string | null> }) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<BuilderImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    const problem = await onSend(text, images);
    if (problem) setError(problem);
    else {
      setText('');
      setImages([]);
    }
    setBusy(false);
  };
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/80 p-2">
      <textarea
        className="tl-scroll min-h-20 w-full resize-y bg-transparent px-2 py-1.5 text-[15px] text-slate-100 outline-none placeholder:text-slate-500"
        placeholder={placeholder}
        value={text}
        maxLength={8000}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
        }}
      />
      <div className="flex items-center gap-2 px-1">
        <label className="flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-slate-400 hover:bg-slate-800 hover:text-slate-200" title="Attach screenshots or photos">
          <ImagePlus size={16} />
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])].slice(0, 3);
              void Promise.all(files.map(readPhoto)).then(setImages);
            }}
          />
          {images.length > 0 ? `${images.length} attached` : 'Image'}
        </label>
        {error && <span className="min-w-0 flex-1 truncate text-sm text-rose-300">{error}</span>}
        <button
          type="button"
          disabled={busy || !text.trim()}
          onClick={() => void submit()}
          className="ml-auto flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-40"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} {button}
        </button>
      </div>
    </div>
  );
}

function Badge({ status }: { status: RequestStatus }) {
  const s = STATUS[status];
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${s.tone}`}>{s.label}</span>;
}

function Thread({ r, onChange }: { r: RequestSummary; onChange: () => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [r.messages.length, r.progress.length, r.status]);
  const act = async (body: object) => {
    setProblem(null);
    const { ok, json } = await send(`/api/builder/${r.id}`, body);
    if (!ok) setProblem(json.error ?? 'That did not work.');
    onChange();
    return ok ? null : (json.error ?? 'That did not work.');
  };
  const working = r.status === 'running' || r.status === 'queued';
  const canFollowUp = ['proposed', 'done', 'applied', 'failed', 'cancelled'].includes(r.status);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="tl-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-1 pb-4">
        {r.messages.map((m, i) => (
          <div key={i} className={m.role === 'person' ? 'flex justify-end' : 'flex justify-start'}>
            <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-[15px] leading-relaxed ${m.role === 'person' ? 'bg-emerald-600/25 text-emerald-50' : 'border border-slate-800 bg-slate-900 text-slate-100'}`}>
              {m.text}
            </div>
          </div>
        ))}

        {(working || r.status === 'merging' || r.status === 'merge_queued') && (
          <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3 text-sm text-slate-400">
            <div className="mb-1 flex items-center gap-2 text-slate-300">
              <Loader2 size={14} className="animate-spin text-cyan-300" />
              {r.status === 'queued' ? 'Waiting for the worker on your PC' : r.status === 'running' ? 'Working' : 'Pushing it live (Railway redeploys in a few minutes)'}
            </div>
            {r.progress.slice(-8).map((p, i) => <div key={i} className="font-mono text-[12px] text-slate-500">· {p}</div>)}
          </div>
        )}

        {r.error && <div role="alert" className="rounded-2xl border border-rose-900 bg-rose-950/40 p-3 text-sm whitespace-pre-wrap text-rose-200">{r.error}</div>}

        {r.proposal && (r.status === 'proposed' || r.status === 'merge_queued' || r.status === 'merging' || r.status === 'applied') && (
          <section className="rounded-2xl border border-emerald-900/70 bg-emerald-950/20 p-3">
            <h3 className="text-sm font-semibold text-emerald-200">Proposed code change</h3>
            <p className="mt-1 text-xs text-slate-400">{r.proposal.checks}</p>
            <ul className="mt-2 space-y-0.5 font-mono text-[12px] text-slate-300">
              {r.proposal.files.map((f) => <li key={f}>{f}</li>)}
            </ul>
            {r.shotCount > 0 && (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {Array.from({ length: r.shotCount }, (_, n) => (
                  <a key={n} href={`/api/builder/${r.id}/shots/${n}?v=${r.updatedAt}`} target="_blank" rel="noreferrer">
                    <img src={`/api/builder/${r.id}/shots/${n}?v=${r.updatedAt}`} alt={`Screenshot ${n + 1}`} className="w-full rounded-lg border border-slate-800" />
                  </a>
                ))}
              </div>
            )}
            {r.status === 'proposed' && (
              <button type="button" onClick={() => void act({ action: 'approve' })} className="mt-3 flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-medium text-slate-950 hover:bg-emerald-400">
                <Check size={15} /> Approve and go live
              </button>
            )}
          </section>
        )}
        {problem && <p role="alert" className="text-sm text-rose-300">{problem}</p>}
        <div ref={end} />
      </div>

      <div className="shrink-0 pt-2">
        {working && (
          <button type="button" onClick={() => void act({ action: 'cancel' })} className="mb-2 flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:border-rose-700 hover:text-rose-200">
            <Square size={13} /> Stop
          </button>
        )}
        {canFollowUp && (
          <Composer
            placeholder={r.status === 'proposed' ? 'Ask for changes to this before approving…' : 'Ask a follow-up or for more changes…'}
            button="Send"
            onSend={(text, images) => act({ action: 'follow-up', text, images })}
          />
        )}
      </div>
    </div>
  );
}

export function BuilderPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(window.location.search).get('r'));

  const load = useCallback(async () => {
    const res = await fetch('/api/builder');
    if (res.status === 401) {
      window.location.replace(`/unlock?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      return;
    }
    const json = (await res.json().catch(() => ({}))) as Overview & { error?: string };
    if (!res.ok) setError(json.error ?? `The server answered ${res.status}.`);
    else {
      setError(null);
      setData(json);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const select = (id: string | null) => {
    setSelected(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('r', id);
    else url.searchParams.delete('r');
    window.history.replaceState(null, '', url);
  };

  const current = data?.requests.find((r) => r.id === selected) ?? null;

  return (
    <div className="flex h-full flex-col bg-[#02040b] text-slate-200 select-text" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <header className="flex shrink-0 items-center gap-3 border-b border-slate-800 px-4 py-3">
        <a href="/" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white" title="Back to the simulation">
          <ArrowLeft size={18} />
        </a>
        <MessageSquareText size={18} className="text-emerald-300" />
        <h1 className="text-base font-semibold text-slate-100">Builder</h1>
        {data && (
          <div className="ml-auto flex items-center gap-3 text-xs text-slate-400">
            <span className="hidden sm:inline">${data.spentUsd.toFixed(2)} of ${data.dailyLimitUsd} today</span>
            <span className="flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${data.workerOnline ? 'bg-emerald-400' : 'bg-slate-600'}`} />
              {data.workerOnline ? 'PC online' : 'PC offline'}
            </span>
          </div>
        )}
      </header>

      {error && <p role="alert" className="mx-4 mt-3 rounded-xl border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</p>}

      <div className="flex min-h-0 flex-1">
        <aside className={`${current ? 'hidden md:flex' : 'flex'} w-full shrink-0 flex-col border-slate-800 md:w-80 md:border-r`}>
          <div className="p-3">
            <button type="button" onClick={() => select(null)} className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:border-emerald-600 hover:text-emerald-200">
              <Plus size={15} /> New request
            </button>
          </div>
          <div className="tl-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {data?.requests.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => select(r.id)}
                className={`mb-1 flex w-full flex-col gap-1 rounded-xl px-3 py-2 text-left hover:bg-slate-900 ${r.id === selected ? 'bg-slate-900' : ''}`}
              >
                <div className="flex w-full items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-100">{r.title}</span>
                  <Badge status={r.status} />
                </div>
                <span className="text-[11px] text-slate-500">{new Date(r.createdAt).toLocaleString()} · ${r.costUsd.toFixed(2)}</span>
              </button>
            ))}
            {data && data.requests.length === 0 && <p className="px-3 py-2 text-sm text-slate-500">Nothing yet.</p>}
          </div>
        </aside>

        <main className={`${current ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col p-3 md:p-4`}>
          {current ? (
            <>
              <div className="mb-3 flex shrink-0 items-center gap-2">
                <button type="button" onClick={() => select(null)} className="rounded-lg p-1 text-slate-400 hover:text-white md:hidden" aria-label="All requests">
                  <ArrowLeft size={16} />
                </button>
                <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-slate-300">{current.title}</h2>
                <Badge status={current.status} />
              </div>
              <Thread r={current} onChange={() => void load()} />
            </>
          ) : (
            <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-4">
              <div>
                <h2 className="text-xl font-semibold text-slate-100">Suggest a change, or ask a question</h2>
                <p className="mt-1 text-sm leading-relaxed text-slate-400">
                  A coding agent on your PC works on it. Questions get an answer here. Code changes are checked, screenshotted and wait for your approval; approving pushes them to GitHub and Railway redeploys.
                  {data && !data.workerOnline && ' Your PC is offline right now, so requests will wait until the worker is running.'}
                </p>
              </div>
              <Composer
                placeholder="e.g. Colonies keep crashing — make the world stable enough to hold a population. / Why does the background flicker?"
                button="Send"
                onSend={async (text, images) => {
                  const { ok, json } = await send('/api/builder', { prompt: text, images });
                  if (!ok) return json.error ?? 'That did not work.';
                  await load();
                  if (json.id) select(json.id);
                  return null;
                }}
              />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
