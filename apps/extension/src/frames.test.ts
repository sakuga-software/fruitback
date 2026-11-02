import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type FrameView, areaInTab, frameRole, holdsWidget } from './frames.ts';

function view(origin: string, declares = false): FrameView {
  const self: FrameView = {
    location: { origin },
    document: { querySelector: (selector) => (declares && selector.includes('frames') ? {} : null) },
    top: null,
    parent: null,
  };
  self.top = self;
  self.parent = self;

  return self;
}

function frameOf(parent: FrameView, origin: string): FrameView {
  const frame = view(origin);
  frame.top = parent.top;
  frame.parent = parent;

  return frame;
}

/** A top frame of another origin: the browser throws on a read of its `location`. */
function foreignTop(): FrameView {
  const top = view('https://other.dev', true);
  Object.defineProperty(top, 'location', {
    get() {
      throw new DOMException('Blocked a frame', 'SecurityError');
    },
  });

  return top;
}

describe('frameRole (FRU-578)', () => {
  it('keeps the widget in the top frame of a page that declares nothing', () => {
    assert.equal(frameRole(view('https://acme.dev')), 'page');
    assert.equal(frameRole(frameOf(view('https://acme.dev'), 'https://acme.dev')), 'none');
  });

  it('moves the widget from the top frame of a page that declares its frames to those frames', () => {
    const top = view('https://acme.dev', true);
    assert.equal(frameRole(top), 'host');
    assert.equal(frameRole(frameOf(top, 'https://acme.dev')), 'framed');
    assert.deepEqual(
      ['page', 'host', 'framed', 'none'].filter((role) => holdsWidget(role as never)),
      ['page', 'framed'],
    );
  });

  it('puts no widget in a frame of another origin, in a frame under a frame, or under a top it cannot read', () => {
    const top = view('https://acme.dev', true);
    assert.equal(frameRole(frameOf(top, 'https://cdn.acme.dev')), 'none');
    assert.equal(frameRole(frameOf(frameOf(top, 'https://acme.dev'), 'https://acme.dev')), 'none');
    assert.equal(frameRole(frameOf(foreignTop(), 'https://acme.dev')), 'none');
  });
});

describe('areaInTab (FRU-578)', () => {
  const frame = {
    getBoundingClientRect: () => ({ left: 200, top: 40 }),
    clientLeft: 1,
    clientTop: 2,
    clientWidth: 800,
    clientHeight: 600,
  };

  it('moves an area of a frame by the place of the frame in the tab', () => {
    assert.deepEqual(areaInTab({ left: 10, top: 20, width: 30, height: 40, scale: 2 }, frame, 2), {
      left: 211,
      top: 62,
      width: 30,
      height: 40,
      scale: 2,
    });
  });

  it('takes the whole frame for a capture of the page, and leaves the top frame as it was', () => {
    assert.deepEqual(areaInTab(undefined, frame, 2), { left: 201, top: 42, width: 800, height: 600, scale: 2 });
    assert.equal(areaInTab(undefined, null, 2), undefined);
  });
});
