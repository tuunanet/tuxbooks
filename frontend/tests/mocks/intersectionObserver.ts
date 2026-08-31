import { vi } from "vitest";

/**
 * Deterministic IntersectionObserver fake for jsdom (which has none).
 * Installed globally by tests/setup.ts; tests drive it directly:
 *
 *   const [visible, preload] = intersectionObservers();
 *   fireIntersection(visible, element, true);
 *
 * The fake records observed elements so each instance can be identified by
 * creation order (the virtualization hook creates the visible observer
 * first, then the preload observer) and fired per element.
 */
export class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];

  readonly callback: IntersectionObserverCallback;
  readonly observed = new Set<Element>();

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    MockIntersectionObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.add(target);
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }

  disconnect(): void {
    this.observed.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

/** Reset between tests: setup.ts installs a fresh set per file, and tests
 * clear instances so creation-order lookups stay unambiguous. */
export function resetIntersectionObservers(): void {
  MockIntersectionObserver.instances = [];
}

/** Observer instances in creation order. */
export function intersectionObservers(): MockIntersectionObserver[] {
  return MockIntersectionObserver.instances;
}

/** Deliver a synthetic entry for `element` to one observer. */
export function fireIntersection(
  observer: MockIntersectionObserver,
  element: Element,
  isIntersecting: boolean,
): void {
  if (!observer.observed.has(element)) {
    throw new Error("fireIntersection: element is not observed by this observer");
  }
  const entry = {
    target: element,
    isIntersecting,
    intersectionRatio: isIntersecting ? 1 : 0,
  } as IntersectionObserverEntry;
  observer.callback([entry], observer as unknown as IntersectionObserver);
}

/** Install the fake as the global constructor. */
export function installMockIntersectionObserver(): void {
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
}
