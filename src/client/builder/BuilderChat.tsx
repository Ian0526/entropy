/**
 * Builder chat: suggest a change or ask a question in plain words. A coding agent on the owner's PC
 * works on it; code changes wait here for approval, and approving pushes them, which deploys them.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ImagePlus, Loader2, MessageSquareText, Plus, Send, Square, X } from 'lucide-react';
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
              <div className="mt-3 grid gap-2">
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

/**
 * Builder as a chat window over the simulation: a floating panel on desktop, a full-screen
 * sheet on phones. Three views in one column: the request list, one conversation, a new request.
 * It only polls the server while open.
 */
export function BuilderChat({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  /** null = the request list, 'new' = composing, otherwise a request id. */
  const [view, setView] = useState<string | null>(null);
  const firstLoad = useRef(true);

  const load = useCallback(async () => {
    const res = await fetch('/api/builder');
    if (res.status === 401) {
      setLocked(true);
      return;
    }
    const json = (await res.json().catch(() => ({}))) as Overview & { error?: string };
    if (!res.ok) setError(json.error ?? `The server answered ${res.status}.`);
    else {
      setError(null);
      setData(json);
      if (firstLoad.current && json.requests.length === 0) setView('new');
      firstLoad.current = false;
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const current = view && view !== 'new' ? data?.requests.find((r) => r.id === view) ?? null : null;
  const title = view === 'new' ? 'New request' : current ? current.title : 'Builder';

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-50 flex flex-col bg-[#02040b] text-slate-200 select-text lg:inset-auto lg:bottom-24 lg:right-4 lg:top-4 lg:w-[420px] lg:rounded-2xl lg:border lg:border-slate-800 lg:bg-slate-950/95 lg:shadow-2xl lg:shadow-black/60 lg:backdrop-blur-md"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
      role="dialog"
      aria-label="Builder chat"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-slate-800 px-3 py-2.5">
        {view !== null ? (
          <button type="button" onClick={() => setView(null)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white" aria-label="All requests">
            <ArrowLeft size={16} />
          </button>
        ) : (
          <MessageSquareText size={16} className="ml-1.5 text-emerald-300" />
        )}
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-100">{title}</h2>
        {current && <Badge status={current.status} />}
        {data && !current && (
          <span className="flex items-center gap-1.5 text-[11px] text-slate-400" title={`$${data.spentUsd.toFixed(2)} of $${data.dailyLimitUsd} used today`}>
            <span className={`h-2 w-2 rounded-full ${data.workerOnline ? 'bg-emerald-400' : 'bg-slate-600'}`} />
            {data.workerOnline ? 'PC online' : 'PC offline'}
          </span>
        )}
        <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white" aria-label="Close Builder">
          <X size={16} />
        </button>
      </header>

      {locked && (
        <p className="m-3 rounded-xl border border-slate-700 p-3 text-sm text-slate-300">
          Your session expired. <a className="text-emerald-300 underline" href="/unlock?next=%2F%3Fbuilder%3D1">Unlock again</a>.
        </p>
      )}
      {error && <p role="alert" className="m-3 rounded-xl border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</p>}

      <div className="flex min-h-0 flex-1 flex-col p-3">
        {view === null && (
          <>
            <button type="button" onClick={() => setView('new')} className="mb-2 flex w-full shrink-0 items-center justify-center gap-1.5 rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:border-emerald-600 hover:text-emerald-200">
              <Plus size={15} /> New request
            </button>
            <div className="tl-scroll -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
              {data?.requests.map((r) => (
                <button key={r.id} type="button" onClick={() => setView(r.id)} className="mb-1 flex w-full flex-col gap-1 rounded-xl px-3 py-2 text-left hover:bg-slate-900">
                  <div className="flex w-full items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-100">{r.title}</span>
                    <Badge status={r.status} />
                  </div>
                  <span className="text-[11px] text-slate-500">{new Date(r.createdAt).toLocaleString()} · ${r.costUsd.toFixed(2)}</span>
                </button>
              ))}
              {data && data.requests.length === 0 && <p className="px-3 py-2 text-sm text-slate-500">Nothing yet.</p>}
            </div>
          </>
        )}

        {view === 'new' && (
          <div className="flex flex-1 flex-col justify-end gap-3">
            <p className="text-sm leading-relaxed text-slate-400">
              Suggest a change or ask a question. A coding agent on your PC works on it. Questions get an answer here; code changes are checked and screenshotted, then wait for your approval. Approving pushes them live.
              {data && !data.workerOnline && ' Your PC is offline right now, so this will wait until the worker is running.'}
            </p>
            <Composer
              placeholder="e.g. Make the 3D nebulae drift a bit faster. / Why do armored cells form on the edges?"
              button="Send"
              onSend={async (text, images) => {
                const { ok, json } = await send('/api/builder', { prompt: text, images });
                if (!ok) return json.error ?? 'That did not work.';
                await load();
                if (json.id) setView(json.id);
                return null;
              }}
            />
          </div>
        )}

        {current && <Thread r={current} onChange={() => void load()} />}
      </div>
    </div>
  );
}
