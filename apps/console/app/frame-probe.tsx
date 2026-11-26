import { Frame, Rail, SECTIONS } from './routes/workspace';
import { VIEWS } from './saved-views';

/**
 * The bar with every section, « Notes » as the section on screen, and the counts of the mockup of
 * FRU-684, given here as the read of the bar gives them (FRU-711). Under them, the views of FRU-697 with the count of the mockup. It is a page of the development server only, like `/kit`:
 * `e2e/console-frame.spec.ts` measures the order of the entries, the entry on screen and the counts here.
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
          onSettings={() => {}}
          account={{ id: 'a1', email: 'ana@acme.dev', name: 'Ana Moreau' }}
          counts={{ notes: 12, sites: 4 }}
          failing={2}
          views={VIEWS}
          viewCounts={{ assigned: 4 }}
        />
      }
    />
  );
}
