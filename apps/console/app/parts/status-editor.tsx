import { useEffect, useRef, useState } from 'react';
import { STAGES, STAGE_NAMES, type Stage } from '../stages';
import { msg, t } from '../i18n';
import { MAX_STATUSES, type ScreenStatus, colourOf, reads } from '../site-statuses';
import { Button, Choice, Field, Problem, Radios } from '../ui';
import { useLocale } from '../use-locale';
import { StatusMark } from './status-list';
import { coloursOf, defaultColourOf, nameHintOf, nameOf, ratioText } from './status-shown';

// The editor of a status of the Statuses screen (FRU-371, FRU-614), and the move of its notes before a delete.

/**
 * The contrast of a text on its status, in words and with a mark, never by its colour alone (FRU-504):
 * « Readable » or « Low contrast ». The ratio and whether the text is Auto are in the tooltip and for a
 * screen reader; the editor says the ratio in a sentence.
 */
export function Ratio({ ratio, auto }: { ratio: number | undefined; auto: boolean }) {
  useLocale();
  if (ratio === undefined) return <span className="text-muted">{auto ? t('Auto') : '·'}</span>;
  const detail = auto
    ? t('Contrast {ratio}, text colour Auto', { ratio: ratioText(ratio) })
    : t('Contrast {ratio}', { ratio: ratioText(ratio) });

  return reads(ratio) ? (
    <span title={detail} className="inline-flex items-center gap-[5px] text-done">
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-[16px] w-[16px] flex-none">
        <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
      {t('Readable')}
      <span className="sr-only">, {detail}</span>
    </span>
  ) : (
    <span title={detail} className="inline-flex items-center gap-[5px] font-semibold text-accent-strong">
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-[16px] w-[16px] flex-none">
        <path d="M12 3l10 18H2z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        <path d="M12 10v5M12 18v.01" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
      {t('Low contrast')}
      <span className="sr-only">, {detail}</span>
    </span>
  );
}

/** What the preview says of the contrast of its text, as the field of the text will be judged. */
function RatioSentence({ ratio }: { ratio: number | undefined }) {
  useLocale();
  if (ratio === undefined) return t('Type a colour to see how its text reads.');
  if (reads(ratio)) return t('Text on this colour: {ratio}. It reads well.', { ratio: ratioText(ratio) });

  return t('Text on this colour: {ratio}. Text needs 4.5:1 at least: choose Auto, or a darker or lighter text.', {
    ratio: ratioText(ratio),
  });
}

type EditorProps = {
  status: ScreenStatus;
  /** A status the team adds: its name is required, and the button says « Add the status ». */
  adding?: boolean;
  disabled: boolean;
  /** Writes it: the sentence of the refusal, or `undefined` once it is kept. */
  onSave: (status: ScreenStatus) => Promise<string | undefined>;
  onCancel: () => void;
};

/**
 * The name, the stage and the colours of a status, with a preview and the contrast of its text.
 *
 * WARNING: no refusal clears a field (FRU-164). A text under 4.5:1 is not sent: the press gives focus to
 * the field of the text, which the sentence describes. The worker refuses it anyway (`text-under-contrast`).
 */
export function StatusEditor({ status, adding = false, disabled, onSave, onCancel }: EditorProps) {
  useLocale();
  const [name, setName] = useState(status.name ?? '');
  const [stage, setStage] = useState<Stage>(status.stage);
  const [background, setBackground] = useState<'stage' | 'own'>(status.color === null ? 'stage' : 'own');
  const [typedBackground, setTypedBackground] = useState(status.color ?? '');
  const [text, setText] = useState<'auto' | 'own'>(status.textColor === null ? 'auto' : 'own');
  const [typedText, setTypedText] = useState(status.textColor ?? '');
  const [errors, setErrors] = useState<{ name?: string; background?: string; text?: string }>({});
  const [problem, setProblem] = useState<string | undefined>();
  const title = useRef<HTMLHeadingElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const backgroundField = useRef<HTMLInputElement>(null);
  const textField = useRef<HTMLInputElement>(null);

  // A press of « Edit » or « Add a status » opened it: focus goes to it, and the field of the name first
  // for a new one.
  useEffect(() => {
    (adding ? nameField.current : title.current)?.focus();
  }, [adding]);

  const color = background === 'own' ? (colourOf(typedBackground) ?? null) : null;
  // A text colour goes with a colour of the team only: the worker refuses one on the colour of a stage
  // or of the tracker (`text-without-color`), and the list would not draw it (lite review of pull
  // request 495). With no colour of its own, the text is Auto.
  const textChoice = background === 'own' ? text : 'auto';
  const textColor = textChoice === 'own' ? (colourOf(typedText) ?? null) : null;
  // With no colour of its own, the status takes its default: the tracker's when the site asks, else its stage's.
  const drawn = coloursOf(stage, background === 'own' ? color : (status.defaultColor ?? null), textColor);
  // A colour that is not typed yet draws nothing of its own: the stage, until it is one.
  const ownTyped = background === 'own' && color === null;
  const fallback = adding ? t('New status') : nameOf({ ...status, name: null });
  const nameShown = name.trim() === '' ? fallback : name.trim();
  // A built-in status keeps its stage (`400 built-in-stage`): the notes with no status of their own are in it.
  const editable = !status.builtIn;
  const typeColour = msg('Type a colour as # and six digits or letters from a to f.');

  async function submit() {
    const found: typeof errors = {};
    if (adding && name.trim() === '') found.name = t('Give the status a name.');
    if (background === 'own' && color === null) found.background = t(typeColour);
    if (textChoice === 'own' && textColor === null) found.text = t(typeColour);
    else if (textChoice === 'own' && !reads(drawn.ratio))
      found.text = t('Text needs 4.5:1 at least: choose Auto, or a darker or lighter text.');
    setErrors(found);
    setProblem(undefined);
    // Focus goes to the first field the press refused, which its sentence describes.
    if (found.name !== undefined) return nameField.current?.focus();
    if (found.background !== undefined) return backgroundField.current?.focus();
    if (found.text !== undefined) return textField.current?.focus();
    const refused = await onSave({
      ...status,
      name: name.trim() === '' ? null : name.trim(),
      stage,
      color: background === 'own' ? color : null,
      textColor: textChoice === 'own' ? textColor : null,
    });
    if (refused !== undefined) setProblem(refused);
  }

  const heading = adding ? t('Add a status') : t('Edit {name}', { name: nameOf(status) });

  return (
    <section
      aria-label={heading}
      className="mt-[4px] rounded-frame border border-line bg-surface p-[20px] max-[480px]:p-[14px]"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onCancel();
      }}
    >
      <h3 ref={title} tabIndex={-1} className="mb-[14px] text-step font-semibold [overflow-wrap:anywhere]">
        {heading}
      </h3>
      <div className="grid grid-cols-1 gap-[24px] min-[960px]:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex max-w-[440px] min-w-0 flex-col gap-[18px]">
          <Field
            label={t('Name')}
            value={name}
            maxLength={200}
            inputRef={nameField}
            onChange={(event) => setName(event.target.value)}
            {...(adding ? {} : { placeholder: nameOf({ ...status, name: null }) })}
            {...(nameHintOf(status) === undefined ? {} : { hint: nameHintOf(status) })}
            {...(errors.name === undefined ? {} : { error: errors.name })}
          />
          <Choice
            label={t('Stage')}
            value={stage}
            status={stage}
            disabled={!editable}
            onChange={(value) => setStage(value as Stage)}
            options={STAGES.map((each) => ({ value: each, label: t(STAGE_NAMES[each]) }))}
            hint={
              editable
                ? t('The stage decides the filters, the counts, and when a note looks fixed.')
                : t('A built-in status keeps its stage: the notes with no status of their own are in it.')
            }
          />
          <div className="flex flex-col gap-[8px]">
            <Radios
              label={t('Colour')}
              value={background}
              onChange={setBackground}
              options={[
                { value: 'stage', label: t(defaultColourOf(status)) },
                { value: 'own', label: t('Your colour') },
              ]}
            />
            {background === 'own' ? (
              <span className="flex items-start gap-[10px] pl-[26px]">
                <span
                  aria-hidden="true"
                  className="kit-swatch mt-[35px]"
                  style={{ background: drawn.style.background }}
                />
                <span className="w-[180px]">
                  <Field
                    code
                    label={t('Hex code of the colour')}
                    placeholder="#rrggbb"
                    value={typedBackground}
                    inputRef={backgroundField}
                    onChange={(event) => setTypedBackground(event.target.value)}
                    {...(errors.background === undefined ? {} : { error: errors.background })}
                  />
                </span>
              </span>
            ) : null}
          </div>
          <div className="flex flex-col gap-[8px]">
            <Radios
              label={t('Text')}
              value={textChoice}
              onChange={setText}
              disabled={background !== 'own'}
              {...(background === 'own'
                ? {}
                : { hint: t('A text colour of your own goes with a colour of your own.') })}
              options={[
                { value: 'auto', label: t('Auto: dark or white, whichever reads better') },
                { value: 'own', label: t('Your colour') },
              ]}
            />
            {textChoice === 'own' ? (
              <span className="flex items-start gap-[10px] pl-[26px]">
                <span
                  aria-hidden="true"
                  className="kit-swatch mt-[35px]"
                  style={{ background: textColor ?? undefined }}
                />
                <span className="w-[180px]">
                  <Field
                    code
                    label={t('Hex code of the text')}
                    placeholder="#rrggbb"
                    value={typedText}
                    inputRef={textField}
                    onChange={(event) => setTypedText(event.target.value)}
                    {...(errors.text === undefined ? {} : { error: errors.text })}
                  />
                </span>
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-[10px]">
          <span className="text-label font-semibold">{t('Preview')}</span>
          {/* The preview is a picture of the colours chosen, even those the screen refuses: hidden from
              a screen reader, which reads the sentence under it (the contrast, in words). */}
          <div aria-hidden="true" data-sample className="flex flex-col gap-[10px]">
            <div className="flex flex-col gap-[10px] rounded-box border border-line bg-subtle p-[14px]">
              <span className="text-tiny text-muted">{t('On a light page')}</span>
              <StatusMark name={nameShown} style={drawn.style} />
            </div>
            <div className="flex flex-col gap-[10px] rounded-box bg-rail p-[14px]">
              <span className="text-tiny text-rail-text">{t('On a dark page')}</span>
              <StatusMark name={nameShown} style={drawn.style} />
            </div>
          </div>
          <p role="status" className="text-small">
            {ownTyped ? t('Type a colour to see how its text reads.') : <RatioSentence ratio={drawn.ratio} />}
          </p>
        </div>
      </div>
      {problem === undefined ? null : (
        <div className="mt-[14px]">
          <Problem>{t(problem, { count: MAX_STATUSES })}</Problem>
        </div>
      )}
      <div className="mt-[18px] flex flex-wrap gap-[10px]">
        <Button size="panel" disabled={disabled} onClick={() => void submit()}>
          {adding ? t('Add the status') : t('Save')}
        </Button>
        <Button tone="outline" onClick={onCancel}>
          {t('Cancel')}
        </Button>
      </div>
    </section>
  );
}

type MoveNotesProps = {
  status: ScreenStatus;
  notes: number;
  targets: readonly ScreenStatus[];
  disabled: boolean;
  onMove: (target: ScreenStatus) => void;
  onKeep: () => void;
};

/** The second step of deleting a status that holds notes: where they go. The built-in status of its stage first. */
export function MoveNotes({ status, notes, targets, disabled, onMove, onKeep }: MoveNotesProps) {
  useLocale();
  const ordered = [
    ...targets.filter((each) => each.builtIn && each.defaultStage === status.stage),
    ...targets.filter((each) => !(each.builtIn && each.defaultStage === status.stage)),
  ];
  const [chosen, setChosen] = useState(ordered[0]?.key ?? '');
  const target = ordered.find((each) => each.key === chosen);
  const name = nameOf(status);

  return (
    <div
      role="group"
      aria-label={t('Delete {name}', { name })}
      className="mt-[4px] flex flex-col gap-[12px] rounded-frame border border-line bg-surface p-[20px] max-[480px]:p-[14px]"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onKeep();
      }}
    >
      <p className="text-body">
        <strong className="font-semibold">
          {notes === 1
            ? t('1 note is in « {name} ».', { name })
            : t('{count} notes are in « {name} ».', { count: notes, name })}
        </strong>{' '}
        {t('Choose where they go, then it is deleted. They take the stage of their new status.')}
      </p>
      <Radios
        label={t('Move them to')}
        value={chosen}
        onChange={setChosen}
        options={ordered.map((each) => ({
          value: each.key,
          label: `${nameOf(each)} · ${t(STAGE_NAMES[each.stage])}`,
        }))}
      />
      <div className="flex flex-wrap gap-[10px]">
        <Button tone="quiet" autoFocus onClick={onKeep}>
          {t('Keep it')}
        </Button>
        <Button tone="danger" disabled={disabled || target === undefined} onClick={() => target && onMove(target)}>
          {notes === 1 ? t('Move 1 note and delete') : t('Move {count} notes and delete', { count: notes })}
        </Button>
      </div>
    </div>
  );
}
