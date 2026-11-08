import { useState } from 'react';
import { Dna, Lock } from 'lucide-react';

/** Only same-site paths are valid places to return to after unlocking. */
function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(next)) return '/';
  return next;
}

export function UnlockPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch('/api/session/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    if (res.ok) {
      window.location.replace(safeNext(new URLSearchParams(window.location.search).get('next')));
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setError(body.error ?? 'That did not work.');
    setBusy(false);
  };

  return (
    <div className="flex h-full items-center justify-center bg-[#02040b] p-4 select-text">
      <form onSubmit={(e) => void submit(e)} className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-950/80 p-6 shadow-2xl">
        <div className="mb-5 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400 to-fuchsia-500">
            <Dna size={18} className="text-slate-950" />
          </div>
          <div className="text-lg font-semibold text-slate-100">TuringLife</div>
        </div>
        <label className="block text-sm text-slate-400">
          Password
          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 outline-none focus:border-emerald-500"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p role="alert" className="mt-2 text-sm text-rose-300">{error}</p>}
        <button type="submit" disabled={busy || !password} className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-500 px-3 py-2 font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-50">
          <Lock size={15} /> {busy ? 'Unlocking' : 'Unlock'}
        </button>
      </form>
    </div>
  );
}
