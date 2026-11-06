import { msg, t } from '../i18n';
import { Chip, LinkButton } from '../ui';
import { useLocale } from '../use-locale';
import { ConnectorMark, type MarkedKind } from '../connector-marks';

/**
 * The recipes that start an agent with no code (FRU-595), under the sources to add of « Connectors »:
 * Linear delegates the issue of a note to an agent of its workspace, and GitHub Actions runs Claude
 * Code on the issue of a note. Neither has a field: no secret goes to Fruitback, and each card leads
 * to its steps in `docs/agents.md`. The cards of every recipe, with their board, are FRU-593.
 */

/** Where the steps of each recipe are written. */
const GUIDE = 'https://fruitback.com/agents.html';

const RECIPES: readonly { kind: MarkedKind; name: string; detail: string; anchor: string }[] = [
  {
    kind: 'linear',
    name: msg('An agent of Linear'),
    detail: msg('Each note becomes a Linear issue. Delegate it to an agent your Linear workspace installed.'),
    anchor: 'delegate-to-an-agent-of-linear',
  },
  {
    kind: 'github',
    name: msg('Claude Code in GitHub Actions'),
    detail: msg('Each note becomes a GitHub issue, and a workflow of your repository opens a pull request for it.'),
    anchor: 'claude-code-in-github-actions-on-the-issue-of-a-note',
  },
];

export function NoCodeRecipes() {
  useLocale();

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
        {RECIPES.map((recipe) => (
          <li
            key={recipe.anchor}
            className="flex min-w-0 flex-col gap-[12px] rounded-frame border border-line bg-surface p-[16px]"
            data-recipe={recipe.anchor}
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
              <LinkButton
                href={`${GUIDE}#${recipe.anchor}`}
                newTab
                label={t('Open the recipe: {name}', { name: t(recipe.name) })}
              >
                {t('Open the recipe')}
              </LinkButton>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
