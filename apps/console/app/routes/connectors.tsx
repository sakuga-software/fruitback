import { Button, Card } from '../ui';
import { PageHead } from './workspace';

/**
 * The sources (design/boards/4-connectors.png). In this beta every note stays in the workspace: the
 * other sources are drawn where the design puts them, and say when they come (FRU-102).
 */
const LATER = [
  { mark: 'L', name: 'Linear', detail: 'An issue per note, in the team you choose.' },
  { mark: 'G', name: 'GitHub Issues', detail: 'An issue per note, in one repository.' },
  { mark: 'J', name: 'Jira', detail: 'Issues in a Jira Cloud project.' },
  { mark: 'T', name: 'Trello', detail: 'A card per note, in the list you choose.' },
  { mark: 'N', name: 'Notion', detail: 'A row per note in a database.' },
  { mark: '{}', name: 'REST API', detail: 'POST each note to your own endpoint.' },
] as const;

export default function Connectors() {
  return (
    <>
      <PageHead
        title="Connectors"
        lead="Connect a source once. Every site of the workspace can then send its feedback there."
      />
      <h2 className="mb-2 text-sm font-semibold text-muted">Connected</h2>
      <Card className="mb-8 border-ink">
        <div className="flex items-center gap-3 px-4 py-3.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-chip text-sm font-bold">F</span>
          <span className="flex-1">
            <span className="block text-[15px] font-semibold">Fruitback</span>
            <span className="block text-xs text-muted">The notes stay in this workspace, in Europe</span>
          </span>
          <span className="flex items-center gap-1.5 text-sm font-semibold text-done">
            <span className="h-2 w-2 rounded-full bg-done" />
            Working
          </span>
        </div>
      </Card>
      <h2 className="mb-2 text-sm font-semibold text-muted">Add a source</h2>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {LATER.map((source) => (
          <Card key={source.name} className="flex flex-col p-4">
            <div className="mb-2 flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-md bg-chip text-xs font-bold">
                {source.mark}
              </span>
              <span className="text-[15px] font-semibold">{source.name}</span>
            </div>
            <p className="mb-4 flex-1 text-sm text-muted">{source.detail}</p>
            <Button tone="outline" disabled className="self-start" title="After the beta">
              After the beta
            </Button>
          </Card>
        ))}
      </div>
    </>
  );
}
