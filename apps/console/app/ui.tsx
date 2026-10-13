import {
  Alert,
  Description,
  Header,
  Button as HeroButton,
  Chip as HeroChip,
  Input,
  Label,
  ListBox,
  Radio,
  RadioGroup,
  Select,
  Switch,
  TextField,
} from '@heroui/react';
import type { ChangeEvent, FocusEvent, KeyboardEvent, ReactNode, Ref } from 'react';
import { Link } from 'react-router';

/** The pin of the widget, as the mockup draws it beside the name. */
export function Mark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" aria-hidden="true" className="fill-accent">
      <path d="M 64 121.9 L 30.1 87.9 A 48 48 0 1 1 97.9 87.9 Z" />
    </svg>
  );
}

type Tone = 'primary' | 'outline' | 'danger' | 'quiet';
/** The height of a control: of a page (44 px), of a panel or a row (40 px), small (32 px). */
export type ControlSize = 'page' | 'panel' | 'small';

/** The tone of a button, as the variant HeroUI draws it with. */
const VARIANTS = {
  primary: 'primary',
  outline: 'outline',
  danger: 'danger-soft',
  quiet: 'ghost',
} as const satisfies Record<Tone, string>;

/**
 * The classes of a tone. « primary » and « outline » are the two buttons of the mockup. « quiet » and
 * « danger » are of before it, and stay as HeroUI draws them until their screens are drawn again.
 */
const TONE_CLASSES = {
  primary: 'kit-button kit-button--primary',
  outline: 'kit-button kit-button--outline',
  danger: 'rounded-full font-semibold',
  quiet: 'rounded-full font-semibold',
} as const satisfies Record<Tone, string>;

/** Where a control goes when it is a link: a screen of the console, or an address outside it. */
type Destination = {
  /** A screen of the console. */
  to?: string;
  /** An address outside the console. */
  href?: string;
  /** Opens `href` in another tab, so the screen and what is typed on it stay. */
  newTab?: boolean;
};

type ButtonProps = Destination & {
  tone?: Tone;
  /** « page » for a primary button, « panel » for an outlined one, when it is not said. */
  size?: ControlSize;
  /** Takes the whole width of its column. */
  wide?: boolean;
  type?: 'button' | 'submit';
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
  /** Takes focus when it appears: the way back of a confirmation, and the button it gives focus back to. */
  autoFocus?: boolean;
  children: ReactNode;
};

/** A link drawn as a control. A link is never disabled: a control that cannot act is a button. */
function anchor({ to, href, newTab = false }: Destination, className: string, data: object, children: ReactNode) {
  if (to !== undefined)
    return (
      <Link to={to} className={className} {...data}>
        {children}
      </Link>
    );

  return (
    <a href={href} className={className} {...(newTab ? { target: '_blank', rel: 'noreferrer' } : {})} {...data}>
      {children}
    </a>
  );
}

/**
 * A button of HeroUI (FRU-125), in the shapes of the mockup (FRU-232): the pill of the action of a
 * step, and the rectangle of a control.
 *
 * It takes no `title`: a tooltip does not open on a control that is disabled, so the reason a control
 * is disabled is written beside it, where a keyboard and a screen reader find it too.
 */
export function Button({
  tone = 'primary',
  size = tone === 'outline' ? 'panel' : 'page',
  wide = false,
  type = 'button',
  disabled = false,
  onClick,
  className = '',
  autoFocus = false,
  to,
  href,
  newTab,
  children,
}: ButtonProps) {
  const classes = `${TONE_CLASSES[tone]} ${className}`;
  const data = { 'data-size': size, 'data-wide': wide };
  if (to !== undefined || href !== undefined) return anchor({ to, href, newTab }, classes, data, children);

  return (
    <HeroButton
      type={type}
      variant={VARIANTS[tone]}
      isDisabled={disabled}
      autoFocus={autoFocus}
      {...(onClick === undefined ? {} : { onPress: onClick })}
      className={classes}
      {...data}
    >
      {children}
    </HeroButton>
  );
}

/** An outlined button over the whole width of its column: a provider to sign in with. */
export function WideButton({
  disabled = false,
  onClick,
  size = 'page',
  note,
  children,
}: Pick<ButtonProps, 'disabled' | 'onClick' | 'size' | 'children'> & { note?: string }) {
  const button = (
    <Button tone="outline" size={size} wide disabled={disabled} {...(onClick === undefined ? {} : { onClick })}>
      {children}
    </Button>
  );
  if (note === undefined) return button;

  // Why the button is disabled, where everybody reads it. A tooltip does not open on a disabled control.
  return (
    <div>
      {button}
      <p className="mt-1 text-center text-tiny text-muted">{note}</p>
    </div>
  );
}

type LinkButtonProps = Destination & {
  onClick?: () => void;
  disabled?: boolean;
  /**
   * The space above and under the words, which is the target: 8 px (« tight », in a row), 10 px, or
   * 12 px (« loose », beside a button of a page). « inline » is a link in a sentence.
   */
  space?: 'tight' | 'normal' | 'loose' | 'inline';
  autoFocus?: boolean;
  children: ReactNode;
};

/** An action or a link that reads as underlined words: « Use another address », « Rename ». */
export function LinkButton({
  onClick,
  disabled = false,
  space = 'tight',
  autoFocus = false,
  to,
  href,
  newTab,
  children,
}: LinkButtonProps) {
  const data = { 'data-space': space };
  if (to !== undefined || href !== undefined) return anchor({ to, href, newTab }, 'kit-link', data, children);

  return (
    <HeroButton
      type="button"
      variant="ghost"
      isDisabled={disabled}
      autoFocus={autoFocus}
      {...(onClick === undefined ? {} : { onPress: onClick })}
      className="kit-link"
      {...data}
    >
      {children}
    </HeroButton>
  );
}

type IconButtonProps = {
  /** What the button does: its picture says it to the eye alone. */
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  /** 36 px, or 32 px (« small »). */
  size?: 'chip' | 'small';
  /** The button opens a menu. */
  menu?: boolean;
  /** The picture: an `svg` with `aria-hidden`. */
  children: ReactNode;
};

/** A button that is a picture, named for a screen reader. */
export function IconButton({
  label,
  onClick,
  disabled = false,
  size = 'chip',
  menu = false,
  children,
}: IconButtonProps) {
  return (
    <HeroButton
      type="button"
      variant="ghost"
      isIconOnly
      isDisabled={disabled}
      aria-label={label}
      {...(menu ? { 'aria-haspopup': 'menu' as const } : {})}
      {...(onClick === undefined ? {} : { onPress: onClick })}
      className="kit-icon-button"
      data-size={size}
    >
      {children}
    </HeroButton>
  );
}

type FieldProps = {
  label: string;
  /** The label is for a screen reader only: the placeholder shows what to type. */
  labelHidden?: boolean;
  hint?: string;
  value?: string;
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
  type?: 'text' | 'email' | 'url' | 'password';
  /** The keyboard of a phone, for a field that is not `type="url"` so that the screen judges what is typed. */
  inputMode?: 'url';
  placeholder?: string;
  autoComplete?: string;
  maxLength?: number;
  required?: boolean;
  disabled?: boolean;
  /** A text to read and to copy, as what somebody typed in a tab that stopped (FRU-210). */
  readOnly?: boolean;
  /** A value that is set elsewhere: read-only, and drawn as such. */
  locked?: boolean;
  /** 40 px and not 44: a field of a panel or of a row of filters. */
  compact?: boolean;
  onFocus?: (event: FocusEvent<HTMLInputElement>) => void;
};

/** A text field of HeroUI: its label, its input, and the hint the input is described by. */
export function Field({
  label,
  labelHidden = false,
  hint,
  disabled = false,
  required = false,
  locked = false,
  compact = false,
  readOnly = false,
  ...input
}: FieldProps) {
  return (
    <TextField
      fullWidth
      isDisabled={disabled}
      isRequired={required}
      className="kit-field"
      data-compact={compact}
      data-locked={locked}
    >
      <Label className={labelHidden ? 'sr-only' : ''}>{label}</Label>
      <Input {...input} readOnly={readOnly || locked} />
      {hint === undefined ? null : <Description>{hint}</Description>}
    </TextField>
  );
}

export type Option = { value: string; label: string };
/** Options under a heading, like the teams of a tracker and their projects. */
export type OptionGroup = { heading: string; options: Option[] };

type ChoiceProps = {
  label: string;
  /** The label is for a screen reader only: the screen already says what is chosen here. */
  labelHidden?: boolean;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly (Option | OptionGroup)[];
  disabled?: boolean;
  /** 40 px and not 44: a list of a panel or of a row of filters. */
  compact?: boolean;
};

function item(option: Option) {
  return (
    <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
      {option.label}
      <ListBox.ItemIndicator />
    </ListBox.Item>
  );
}

/** One choice in a list, as the select of HeroUI: a button, and a list box the keyboard walks. */
export function Choice({
  label,
  labelHidden = false,
  hint,
  value,
  onChange,
  options,
  disabled = false,
  compact = false,
}: ChoiceProps) {
  return (
    <Select
      fullWidth
      isDisabled={disabled}
      className="kit-field"
      data-compact={compact}
      value={value}
      onChange={(chosen) => {
        if (typeof chosen === 'string') onChange(chosen);
      }}
    >
      <Label className={labelHidden ? 'sr-only' : ''}>{label}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      {hint === undefined ? null : <Description>{hint}</Description>}
      <Select.Popover>
        <ListBox>
          {options.map((each) =>
            'options' in each ? (
              <ListBox.Section key={each.heading}>
                <Header>{each.heading}</Header>
                {each.options.map(item)}
              </ListBox.Section>
            ) : (
              item(each)
            ),
          )}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-frame border border-line bg-surface ${className}`}>{children}</section>;
}

type PickProps<Value extends string> = {
  label: string;
  value: Value;
  onChange: (value: Value) => void;
  options: readonly { value: Value; label: string; detail: string }[];
};

/** One choice among a few, each with a line that says what it means: the radio cards of the mockup. */
export function Pick<Value extends string>({ label, value, onChange, options }: PickProps<Value>) {
  return (
    <RadioGroup value={value} onChange={(chosen) => onChange(chosen as Value)} className="kit-pick">
      <Label>{label}</Label>
      {options.map((option) => (
        <Radio key={option.value} value={option.value} className="kit-pick__card">
          {/* The row of HeroUI holds the control and the label. The detail is under it, as a description. */}
          <Radio.Content>
            <Radio.Control>
              <Radio.Indicator />
            </Radio.Control>
            <Label>{option.label}</Label>
          </Radio.Content>
          <Description>{option.detail}</Description>
        </Radio>
      ))}
    </RadioGroup>
  );
}

type ToggleProps = {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
};

/** A setting that is on or off, as the switch of HeroUI: the label first, the switch at the end of the row. */
export function Toggle({ label, value, onChange, disabled = false }: ToggleProps) {
  return (
    <Switch
      isSelected={value}
      isDisabled={disabled}
      onChange={onChange}
      className="kit-toggle flex w-full flex-row-reverse items-center justify-between gap-4"
    >
      {/* Ink when it is on, as the mockup draws it: the accent is the red of an alert. */}
      <Switch.Control>
        <Switch.Thumb />
      </Switch.Control>
      <Switch.Content>
        <Label>{label}</Label>
      </Switch.Content>
    </Switch>
  );
}

/** The small label of a role or a state, as the members table draws it. */
export function Chip({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'done' }) {
  const color = ({ neutral: 'default', accent: 'accent', done: 'success' } as const)[tone];

  return (
    <HeroChip color={color} variant="soft" size="sm" className="font-semibold">
      {children}
    </HeroChip>
  );
}

/** A problem said where it happened, with what to do about it. */
export function Problem({ children }: { children: ReactNode }) {
  return (
    <Alert status="danger" role="alert">
      <Alert.Content>
        <Alert.Description>{children}</Alert.Description>
      </Alert.Content>
    </Alert>
  );
}

/** A name and its initial, in the round chip of the mockup. `pending`: somebody invited who has not come. */
export function Initial({
  name,
  size = 'row',
  pending = false,
}: {
  name: string;
  /** 32 px in a row of a table, 28 px (« small ») beside a sentence. */
  size?: 'row' | 'small';
  pending?: boolean;
}) {
  return (
    <span className="kit-avatar" data-size={size} data-pending={pending} aria-hidden="true">
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

/** The five statuses of a note, in the order the mockup lists them. */
export const STATUSES = ['new', 'todo', 'progress', 'done', 'closed'] as const;
export type Status = (typeof STATUSES)[number];

/** The colour of a status. The class names are whole, so Tailwind finds them. */
const STATUS_COLOURS = {
  new: 'bg-status-new',
  todo: 'bg-status-todo',
  progress: 'bg-status-progress',
  done: 'bg-status-done',
  closed: 'bg-status-closed',
} as const satisfies Record<Status, string>;

/**
 * The drop of a status. It is a picture for the eye only: the word of the status is always written
 * beside it, because the amber is 2.15:1 on white and a colour alone tells nothing to many people.
 */
export function StatusDot({ status, size = 9 }: { status: Status; size?: 9 | 10 | 11 }) {
  return <span aria-hidden="true" className={`kit-drop ${STATUS_COLOURS[status]}`} data-size={size} />;
}

type StatusBarProps = {
  /** How many notes have each status. A status with none takes no room. */
  counts: Readonly<Record<Status, number>>;
  /** The counts in words, e.g. « 3 new, 2 to do, 4 in progress, 2 done, 1 closed »: the bar is a picture. */
  label: string;
  /** 128 px in a table, 96 px on a tinted track (« short »), or the width of its column (« full »). */
  width?: 'table' | 'short' | 'full';
};

/** The statuses of the notes of a site, as one bar. */
export function StatusBar({ counts, label, width = 'table' }: StatusBarProps) {
  return (
    <span role="img" aria-label={label} className="kit-status-bar" data-width={width}>
      {STATUSES.filter((status) => counts[status] > 0).map((status) => (
        <span key={status} className={STATUS_COLOURS[status]} style={{ flexGrow: counts[status], flexBasis: 0 }} />
      ))}
    </span>
  );
}

type FilterChipProps = {
  pressed: boolean;
  onChange: (pressed: boolean) => void;
  /** How many things the filter keeps, said after its name. */
  count?: number;
  /** The filter is of a problem: « Not delivered ». Its words say so too. */
  alert?: boolean;
  children: ReactNode;
};

/** A filter that is on or off: a button with `aria-pressed`. */
export function FilterChip({ pressed, onChange, count, alert = false, children }: FilterChipProps) {
  return (
    <HeroButton
      type="button"
      variant="outline"
      aria-pressed={pressed}
      onPress={() => onChange(!pressed)}
      className="kit-chip"
      data-alert={alert}
    >
      {children}
      {count === undefined ? null : <span className="kit-chip__count">{count}</span>}
    </HeroButton>
  );
}

type DataTableProps = {
  /** What the table lists. It names the region, which a keyboard scrolls when the table is wider. */
  label: string;
  /** The width under which the table scrolls in its frame, in pixels: 860 for the sites. */
  minWidth: number;
  /** 12 px above and under a cell, and not 14: the rows of people. */
  dense?: boolean;
  /** A row is tinted under the pointer: the rows that open something. */
  hover?: boolean;
  /** `<thead>` and `<tbody>`. A cell with `data-align="end"` is aligned to the right. */
  children: ReactNode;
};

/**
 * A table in its frame. A table wider than the screen scrolls in the frame, and the page does not.
 * The frame takes focus, so a keyboard can scroll it (WCAG 2.1.1).
 */
export function DataTable({ label, minWidth, dense = false, hover = false, children }: DataTableProps) {
  return (
    <div role="region" aria-label={label} tabIndex={0} className="kit-table" data-dense={dense} data-hover={hover}>
      <table style={{ minWidth }}>{children}</table>
    </div>
  );
}

type SidePanelProps = {
  /** An id of the page, which ties the panel to its title. */
  id: string;
  title: string;
  detail?: string;
  /** Under a rule at the bottom: the action that undoes the panel, and a date. */
  foot?: ReactNode;
  /** For a panel that takes focus when somebody opens it (FRU-197). */
  panelRef?: Ref<HTMLElement>;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  className?: string;
  children: ReactNode;
};

/** The panel beside a list: what is chosen in the list, with its settings. */
export function SidePanel({ id, title, detail, foot, panelRef, onKeyDown, className = '', children }: SidePanelProps) {
  return (
    <aside
      ref={panelRef}
      aria-labelledby={id}
      {...(panelRef === undefined ? {} : { tabIndex: -1 })}
      {...(onKeyDown === undefined ? {} : { onKeyDown })}
      className={`kit-panel ${className}`}
    >
      <div className="kit-panel__head">
        <h2 id={id} className="kit-panel__title">
          {title}
        </h2>
        {detail === undefined ? null : <p className="kit-panel__detail">{detail}</p>}
      </div>
      <div className="kit-panel__body">{children}</div>
      {foot === undefined ? null : <div className="kit-panel__foot">{foot}</div>}
    </aside>
  );
}

/** A list of a name and its value: « Signed in as », « Role », « Site ». */
export function KeyValue({ rows }: { rows: readonly { term: string; value: ReactNode }[] }) {
  return (
    <dl className="kit-key-value">
      {rows.map((row) => (
        <div key={row.term}>
          <dt>{row.term}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The green drop with a check: something is done. A picture: the title under it says what. */
export function SuccessMark() {
  return (
    <span aria-hidden="true" className="kit-drop kit-success">
      <svg viewBox="0 0 24 24">
        <path
          d="M5 12.5l4.5 4.5L19 7.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-white"
        />
      </svg>
    </span>
  );
}

/** The title of a page: its one `h1`. « setup » is the larger one of the setup. */
export function Title({ size = 'page', children }: { size?: 'page' | 'setup'; children: ReactNode }) {
  return (
    <h1 className="kit-title" data-size={size}>
      {children}
    </h1>
  );
}

/** The sentence under a title. */
export function Lead({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`kit-lead ${className}`}>{children}</p>;
}

/** The head of a page of a workspace: its title, what the page is for, and the action of the page. */
export function PageHead({
  title,
  lead,
  action,
  className = '',
}: {
  title: string;
  lead: string;
  action?: ReactNode;
  /** The space around the head, which is the screen's. */
  className?: string;
}) {
  return (
    <header className={`kit-page-head ${className}`}>
      <div className="min-w-0">
        <Title>{title}</Title>
        <Lead>{lead}</Lead>
      </div>
      {action ?? null}
    </header>
  );
}
