/**
 * The alarms of the background, as promises in the three browsers (FRU-668). Chrome answers a
 * promise from `alarms.create`. Safari answers `undefined`, so a `.catch` chained on its answer
 * throws at the start of the background, and Safari then loads no background at all.
 */
export type AlarmApi<Info> = {
  create: (name: string, info: Info) => unknown;
  clear: (name: string) => unknown;
};

export type Alarms<Info> = {
  set: (name: string, info: Info) => Promise<void>;
  clear: (name: string) => Promise<void>;
};

export function promisedAlarms<Info>(api: AlarmApi<Info>): Alarms<Info> {
  return {
    set: async (name, info) => {
      await api.create(name, info);
    },
    clear: async (name) => {
      await api.clear(name);
    },
  };
}
