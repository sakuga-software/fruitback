import type { Connector } from '../api';
import { msg, t } from '../i18n';
import { Chip, LinkButton } from '../ui';
import { useLocale } from '../use-locale';
import { ConnectorMark, type MarkedKind } from '../connector-marks';

/**
 * The recipes that start an agent with no code (FRU-595), under « Your connectors »: Linear
 * delegates the issue of a note to an agent of its workspace, and GitHub Actions runs Claude Code on
 * the issue of a note. Each recipe starts from that issue, so its card shows once a tracker of its
 * kind is connected. Neither has a field: no secret goes to Fruitback, and each card leads to its
 * steps in `docs/agents.md`. The cards of every recipe, with their board, are FRU-593.
 */

/**
 * Each `href` names a heading of the guide in full, so `docs-site.test.ts` finds it and fails when
 * the heading changes.
 */
const RECIPES: readonly { kind: MarkedKind & Connector['kind']; name: string; detail: string; href: string }[] = [
  {
    kind: 'linear',
    name: msg('An agent of Linear'),
    detail: msg('Each note becomes a Linear issue. Delegate it to an agent your Linear workspace installed.'),
    href: 'https://fruitback.com/agents.html#delegate-to-an-agent-of-linear',
  },
  {
    kind: 'github',
    name: msg('Claude Code in GitHub Actions'),
    detail: msg('Each note becomes a GitHub issue, and a workflow of your repository opens a pull request for it.'),
    href: 'https://fruitback.com/agents.html#claude-code-in-github-actions-on-the-issue-of-a-note',
  },
];

export function NoCodeRecipes({ kinds }: { kinds: readonly Connector['kind'][] }) {
  useLocale();
  const shown = RECIPES.filter((recipe) => kinds.includes(recipe.kind));
  if (shown.length === 0) return null;

  return (
    <section aria-labelledby="no-code-title" className="mt-[24px] flex flex-col gap-[10px]" data-recipes>
      <div className="flex flex-col gap-[2px]">
        <h3 id="no-code-title" className="text-body leading-auto font-semibold">
          {t('Start an agent, with no code')}
        </h3>
        <p className="text-hint text-muted">
          {t('They use the issue a connector makes of each note. No secret goes to Fruitback.')}
        </p>
      </div>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-[12px]">
        {shown.map((recipe) => (
          <li
            key={recipe.href}
            className="flex min-w-0 flex-col gap-[12px] rounded-frame border border-line bg-surface p-[16px]"
            data-recipe={recipe.href.split('#')[1]}
          >
            <span className="flex items-start gap-[12px]">
              <span
                aria-hidden="true"
                className="box-content flex h-[34px] w-[34px] flex-none items-center justify-center rounded-field border border-line bg-surface text-ink"
              >
                <ConnectorMark kind={recipe.kind} size={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-[8px] gap-y-[4px]">
                  <span className="text-body leading-auto font-semibold">{t(recipe.name)}</span>
                  <Chip>{t('No code')}</Chip>
                </span>
                <span className="block text-hint leading-auto text-muted">{t(recipe.detail)}</span>
              </span>
            </span>
            <div className="mt-auto">
              <LinkButton href={recipe.href} newTab label={t('Open the recipe: {name}', { name: t(recipe.name) })}>
                {t('Open the recipe')}
              </LinkButton>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
