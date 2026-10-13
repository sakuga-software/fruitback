import {
  Alert,
  Description,
  Dropdown,
  Header,
  Button as HeroButton,
  Checkbox as HeroCheckbox,
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
import { Logo } from './logo';

export { Logo };

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
  /**
   * The padding at each end, in pixels, where the mockup writes another one than the one of the
   * size: 16 on « Send again », 24 on « Invite », 26 on « Connect Chrome ».
   */
  inset?: 14 | 16 | 18 | 22 | 24 | 26;
  type?: 'button' | 'submit';
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
  /** Takes focus when it appears: the way back of a confirmation, and the button it gives focus back to. */
  autoFocus?: boolean;
  /**
   * The name a screen reader says, where the words of the button are not enough alone: seven
   * « Connect » of one list are « Connect Jira », « Connect GitHub ». It starts with the words the
   * button shows, so that somebody who speaks to their browser can say what they read.
   */
  label?: string;
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
  inset,
  type = 'button',
  disabled = false,
  onClick,
  className = '',
  autoFocus = false,
  to,
  href,
  newTab,
  label,
  children,
}: ButtonProps) {
  const classes = `${TONE_CLASSES[tone]} ${className}`;
  const data = {
    'data-size': size,
    'data-wide': wide,
    ...(label === undefined ? {} : { 'aria-label': label }),
    ...(inset === undefined ? {} : { style: { paddingInline: inset } }),
  };
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
   * 12 px (« loose », beside a button of a page). « flush » is « tight » at the end of a line of
   * text, which keeps its height: « Rename », « Change ». « inline » is a link in a sentence.
   */
  space?: 'tight' | 'flush' | 'normal' | 'loose' | 'inline';
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
  type?: 'text' | 'email' | 'url' | 'password' | 'search';
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
  /** Takes focus when it appears: the field a press of « Rename » opens. */
  autoFocus?: boolean;
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
  /**
   * The list chooses a status: its drop is drawn before the chosen word, and the list is the 38 px
   * of a row of « Status of the pins ». The drop is a picture: the word beside it says the status.
   */
  status?: Status;
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
  status,
}: ChoiceProps) {
  return (
    <Select
      fullWidth
      isDisabled={disabled}
      className="kit-field"
      data-compact={compact}
      data-status={status !== undefined}
      value={value}
      onChange={(chosen) => {
        if (typeof chosen === 'string') onChange(chosen);
      }}
    >
      <Label className={labelHidden ? 'sr-only' : ''}>{label}</Label>
      <Select.Trigger>
        {status === undefined ? null : <StatusDot status={status} />}
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

type CheckboxProps = { label: string; checked: boolean; onChange: (checked: boolean) => void };

/**
 * A box to tick, as the checkbox of HeroUI: the box of 16 px, then its words, on a line of 40 px at
 * the least, so that it stands in a row of filters (« Only my notes »). Ink when it is ticked.
 */
export function Checkbox({ label, checked, onChange }: CheckboxProps) {
  return (
    <HeroCheckbox isSelected={checked} onChange={onChange} className="kit-checkbox">
      <HeroCheckbox.Control>
        <HeroCheckbox.Indicator />
      </HeroCheckbox.Control>
      <HeroCheckbox.Content>
        <Label>{label}</Label>
      </HeroCheckbox.Content>
    </HeroCheckbox>
  );
}

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
  /** An id for the panel itself: what a row of the list names with `aria-controls` (FRU-197). */
  panelId?: string;
  /** The name of the panel where its title is not it: « Settings of Linear » over the title « Linear ». */
  label?: string;
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
export function SidePanel({
  id,
  panelId,
  label,
  title,
  detail,
  foot,
  panelRef,
  onKeyDown,
  className = '',
  children,
}: SidePanelProps) {
  return (
    <aside
      ref={panelRef}
      {...(panelId === undefined ? {} : { id: panelId })}
      {...(label === undefined ? { 'aria-labelledby': id } : { 'aria-label': label })}
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

/**
 * The word a person compares with the one of another screen (FRU-240): white on ink, in a monospace
 * of 22 px, with what to do beside it. The word is text a screen reader reads, in its own element.
 */
export function VerifyWord({ word, children }: { word: string; children: ReactNode }) {
  return (
    <div className="kit-verify">
      <span className="kit-verify__ask">{children}</span>
      <span className="kit-verify__word">{word}</span>
    </div>
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

/** The site of the product: where the logo of a page outside a workspace leads. */
const SITE = 'https://fruitback.com';

type EntryPageProps = {
  /** The column of the page: 400 px (« narrow »), 440 px (« wide »), or the whole page for the setup. */
  width?: 'narrow' | 'wide' | 'full';
  /** At the end of the header: a sentence and a link, as « Running your own server? ». */
  aside?: ReactNode;
  children: ReactNode;
};

/**
 * A page outside a workspace: the sign-in, an invitation, the setup. A header with the logo, which
 * leads to the site of the product, and one column under it.
 */
export function EntryPage({ width = 'narrow', aside, children }: EntryPageProps) {
  return (
    <div className="kit-entry">
      <header className="kit-entry__header">
        <div>
          <a href={SITE} className="kit-entry__logo">
            <Logo />
          </a>
          {aside ?? null}
        </div>
      </header>
      <main className="kit-entry__main" data-width={width}>
        {width === 'full' ? children : <div className="kit-entry__column">{children}</div>}
      </main>
    </div>
  );
}

/** A rule with a word in its middle: « or », between two ways to do one thing. A picture only. */
export function Divider({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div aria-hidden="true" className={`kit-divider ${className}`}>
      {children}
    </div>
  );
}

export type MenuItem = {
  id: string;
  label: string;
  /** A second line under the label: the role of a person in a workspace. */
  detail?: string;
  /** The item takes something away: « Remove ». */
  danger?: boolean;
  disabled?: boolean;
};

type MenuProps = {
  items: readonly MenuItem[];
  /** The item that is the current one, when the menu is a choice: it is checked. */
  chosen?: string;
  onAction: (id: string) => void;
  /**
   * What opens the menu: a button that is a picture (36 px, named by `triggerLabel`), or a button of
   * the screen, which gives its box with `triggerClassName`.
   */
  trigger?: 'icon' | 'plain';
  triggerLabel?: string;
  triggerClassName?: string;
  /** What the button shows. */
  children: ReactNode;
};

/**
 * A button that opens a menu, as the dropdown of HeroUI: the arrows walk the items, Escape closes
 * the menu and gives focus back to the button. The menu is named after its button, so the button
 * says what the menu lists. The menu is drawn on the surface of a page, wherever its button is.
 */
export function Menu({
  items,
  chosen,
  onAction,
  trigger = 'plain',
  triggerLabel,
  triggerClassName = '',
  children,
}: MenuProps) {
  return (
    <Dropdown>
      <Dropdown.Trigger
        className={`kit-menu-trigger ${trigger === 'icon' ? 'kit-icon-button' : ''} ${triggerClassName}`}
        {...(triggerLabel === undefined ? {} : { 'aria-label': triggerLabel })}
      >
        {children}
      </Dropdown.Trigger>
      <Dropdown.Popover className="kit-menu" placement="bottom start">
        <Dropdown.Menu
          onAction={(id) => onAction(String(id))}
          disabledKeys={items.filter((item) => item.disabled === true).map((item) => item.id)}
          {...(chosen === undefined
            ? {}
            : { selectionMode: 'single' as const, selectedKeys: [chosen], disallowEmptySelection: true })}
        >
          {items.map((item) => (
            <Dropdown.Item key={item.id} id={item.id} textValue={item.label} data-danger={item.danger === true}>
              {chosen === undefined ? null : <Dropdown.ItemIndicator />}
              <span className="kit-menu__words">
                <Label>{item.label}</Label>
                {item.detail === undefined ? null : <Description>{item.detail}</Description>}
              </span>
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** Where a step is: the one to do now, one to come, one that is done. */
export type StepState = 'current' | 'pending' | 'done';

/** The steps of a path, in order: an `<ol>` of `Step`. */
export function Steps({ children }: { children: ReactNode }) {
  return <ol className="kit-steps">{children}</ol>;
}

type StepProps = {
  state: StepState;
  /** The number in the drop. A step that is done shows a check in its place. */
  number: number;
  title: string;
  /** Said before the title of the current step, to a screen reader only: « Current step: ». */
  currentPrefix: string;
  children?: ReactNode;
};

/** One step: its drop, the line down to the next one, its title and what the step holds. */
export function Step({ state, number, title, currentPrefix, children }: StepProps) {
  return (
    <li className="kit-step" data-state={state} {...(state === 'current' ? { 'aria-current': 'step' as const } : {})}>
      <div className="kit-step__rail">
        <span aria-hidden="true" className="kit-drop kit-step__mark">
          {state === 'done' ? (
            <svg viewBox="0 0 24 24">
              <path
                d="M5 12.5l4.5 4.5L19 7.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <span>{number}</span>
          )}
        </span>
        <span aria-hidden="true" className="kit-step__line" />
      </div>
      <div className="kit-step__body">
        <h2 className="kit-step__title">
          {state === 'current' ? <span className="sr-only">{currentPrefix} </span> : null}
          {title}
        </h2>
        {children}
      </div>
    </li>
  );
}

/** Something that happened, said in a box. `status`: it is said to a screen reader when it appears. */
export function Callout({
  status = false,
  className = '',
  children,
}: {
  status?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div {...(status ? { role: 'status' as const } : {})} className={`kit-callout ${className}`}>
      {children}
    </div>
  );
}

/** One way among a few to do a thing, in its card: its name, then what the screen puts in it. */
export function OptionCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="kit-option">
      <h3 className="kit-option__title">{title}</h3>
      {children}
    </div>
  );
}

/**
 * Cards or buttons side by side while each has `min` pixels, then one under the other: no width of
 * a screen is named.
 */
export function AutoGrid({ min = 180, children }: { min?: 180 | 230; children: ReactNode }) {
  return (
    <div className="kit-auto-grid" data-min={min}>
      {children}
    </div>
  );
}

/** Code to copy, as it is typed. Its box takes focus, so a keyboard scrolls a long line. */
export function Snippet({ label, className = '', children }: { label: string; className?: string; children: string }) {
  return (
    <pre role="region" aria-label={label} tabIndex={0} className={`kit-snippet ${className}`}>
      {children}
    </pre>
  );
}

type BrowserFrameProps = {
  /** What is in the bar, where a browser shows an address. */
  address: string;
  /** In place of a page: why there is none yet. */
  empty?: string;
  /** Under the frame: what the picture is. */
  caption?: string;
  /** The page, 620 px high. It is a picture: what it draws answers no pointer and no keyboard. */
  children?: ReactNode;
};

/** The window of a browser, drawn: the preview of a site. */
export function BrowserFrame({ address, empty, caption, children }: BrowserFrameProps) {
  return (
    <>
      <div className="kit-browser">
        <div className="kit-browser__bar">
          <span aria-hidden="true" className="kit-browser__dots">
            <span />
            <span />
            <span />
          </span>
          <span className="kit-browser__address">
            <span>{address}</span>
          </span>
          <span aria-hidden="true" className="kit-browser__dots" />
        </div>
        <div className="kit-browser__page">
          {empty === undefined ? (
            children
          ) : (
            <div className="kit-browser__empty">
              <svg aria-hidden="true" viewBox="16 6 96 116">
                <path
                  d="M 64 121.9 L 30.1 87.9 A 48 48 0 1 1 97.9 87.9 Z M 64 37 A 17 17 0 1 0 64 71 A 17 17 0 1 0 64 37 Z"
                  fillRule="evenodd"
                />
              </svg>
              <p>{empty}</p>
            </div>
          )}
        </div>
      </div>
      {caption === undefined ? null : <p className="kit-browser__caption">{caption}</p>}
    </>
  );
}
