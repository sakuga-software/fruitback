import { Frame, Rail, SECTIONS } from './routes/workspace';

/**
 * The rail with every section of the mockup, « Notes » too, and « Notes » as the section on screen
 * (FRU-234). The frame of a workspace shows a section only when its screen exists, so no screen can
 * put the rail in this state yet. It is a page of the development server only, like `/kit`:
 * `e2e/console-frame.spec.ts` measures the order of the entries and the entry on screen here.
 *
 * The names are samples: no person sees this page.
 */
const WORKSPACES = [
  { id: 'w1', name: 'Acme', role: 'owner' },
  { id: 'w2', name: 'Lumen Studio', role: 'member' },
] as const;

export default function FrameProbe() {
  return (
    <Frame
      rail={
        <Rail
          workspace={WORKSPACES[0]}
          workspaces={WORKSPACES}
          sections={SECTIONS}
          current="notes"
          onWorkspace={() => {}}
        />
      }
    />
  );
}
