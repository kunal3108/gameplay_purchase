type Listener<T extends unknown[]> = (...args: T) => void;

/**
 * Minimal type-safe event emitter with no external dependencies.
 * Extend or compose this in SDK classes that need observable state.
 */
export class TypedEventEmitter<Events extends Record<string, unknown[]>> {
  private readonly _listeners = new Map<keyof Events, Listener<unknown[]>[]>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    const list = this._listeners.get(event) ?? [];
    list.push(listener as Listener<unknown[]>);
    this._listeners.set(event, list);
    return this;
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): this {
    const list = this._listeners.get(event);
    if (list) {
      const idx = list.indexOf(listener as Listener<unknown[]>);
      if (idx !== -1) list.splice(idx, 1);
    }
    return this;
  }

  emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    const list = this._listeners.get(event);
    // Copy before iterating so listeners added during emit don't fire immediately
    if (list) [...list].forEach(fn => fn(...(args as unknown[])));
  }
}
