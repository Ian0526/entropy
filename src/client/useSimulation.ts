import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMsg, InspectResult, SimTelemetry } from '../engine/protocol';
import { CloudSource } from './sim/CloudSource';
import { LocalSource } from './sim/LocalSource';
import type { ConnectionStatus, ResyncResult, SimSource, SimSourceEvents } from './sim/SimSource';

export type SourceKind = 'cloud' | 'local';

/** Latest frame, read by the canvas render loop outside React. */
export interface FrameStore {
  data: Uint8Array | null;
  width: number;
  height: number;
  tick: number;
  version: number;
}

export interface History {
  population: number[];
  species: number[];
  energy: number[];
  distance: number[];
}

const HISTORY_LEN = 180;
const emptyHistory = (): History => ({ population: [], species: [], energy: [], distance: [] });

export function useSimulation() {
  const [kind, setKind] = useState<SourceKind>(() =>
    (typeof localStorage !== 'undefined' && localStorage.getItem('turinglife.source') === 'local') ? 'local' : 'cloud');
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [telemetry, setTelemetry] = useState<SimTelemetry | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<History>(emptyHistory);
  const frameRef = useRef<FrameStore>({ data: null, width: 0, height: 0, tick: 0, version: 0 });
  const sourceRef = useRef<SimSource | null>(null);
  const telemetryRef = useRef<SimTelemetry | null>(null);
  const waiters = useRef(new Map<number, (r: InspectResult | null) => void>());
  const nextId = useRef(1);
  const lastHistTick = useRef(-1);

  useEffect(() => {
    localStorage.setItem('turinglife.source', kind);
    frameRef.current = { data: null, width: 0, height: 0, tick: 0, version: frameRef.current.version + 1 };
    lastHistTick.current = -1;
    setHistory(emptyHistory());
    setTelemetry(null);

    let src: SimSource | null = null;
    const ev: SimSourceEvents = {
      onFrame(frame, width, height, tick) {
        const fs = frameRef.current;
        const prev = fs.data;
        fs.data = frame;
        fs.width = width;
        fs.height = height;
        fs.tick = tick;
        fs.version++;
        if (prev && prev !== frame) src?.recycle(prev);
      },
      onTelemetry(t) {
        telemetryRef.current = t;
        setTelemetry(t);
        if (t.tick !== lastHistTick.current) {
          lastHistTick.current = t.tick;
          setHistory((h) => {
            const push = (arr: number[], v: number) => {
              const out = arr.length >= HISTORY_LEN ? arr.slice(arr.length - HISTORY_LEN + 1) : arr.slice();
              out.push(v);
              return out;
            };
            return {
              population: push(h.population, t.population),
              species: push(h.species, t.species),
              energy: push(h.energy, t.meanEnergy),
              distance: push(h.distance, t.meanDistance),
            };
          });
        }
      },
      onInspect(id, data) {
        const w = waiters.current.get(id);
        if (w) {
          waiters.current.delete(id);
          w(data);
        }
      },
      onStatus: setStatus,
      onNotice(m) {
        setNotice(m);
        setTimeout(() => setNotice((cur) => (cur === m ? null : cur)), 5000);
      },
    };
    src = kind === 'cloud'
      ? new CloudSource(ev)
      : new LocalSource(ev, { params: telemetryRef.current?.params });
    sourceRef.current = src;
    return () => {
      src?.dispose();
      if (sourceRef.current === src) sourceRef.current = null;
    };
  }, [kind]);

  const send = useCallback((msg: ClientMsg) => sourceRef.current?.send(msg), []);

  const inspect = useCallback((x: number, y: number): Promise<InspectResult | null> => {
    const src = sourceRef.current;
    if (!src) return Promise.resolve(null);
    const id = nextId.current++;
    return new Promise((resolve) => {
      waiters.current.set(id, resolve);
      setTimeout(() => {
        if (waiters.current.delete(id)) resolve(null);
      }, 4000);
      src.send({ type: 'inspect', id, x, y });
    });
  }, []);

  const resync = useCallback(async (): Promise<ResyncResult> => {
    return sourceRef.current ? sourceRef.current.resync() : { ok: false, cooldownMs: 1000, reason: 'no-source' };
  }, []);

  const getPool = useCallback(async () => sourceRef.current?.getPool() ?? null, []);

  return { kind, setKind, status, telemetry, notice, history, frameRef, send, inspect, resync, getPool };
}

export type SimulationApi = ReturnType<typeof useSimulation>;
