import {
  Alert,
  Description,
  Dropdown,
  FieldError,
  Header,
  Button as HeroButton,
  Checkbox as HeroCheckbox,
  CheckboxGroup,
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
import {
  type CSSProperties,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useRef,
  useState,
} from 'react';
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
  /** The button shows or hides `controls`: a panel under a row (FRU-462). */
  expanded?: boolean;
  controls?: string;
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
  expanded,
  controls,
  children,
}: ButtonProps) {
  const classes = `${TONE_CLASSES[tone]} ${className}`;
  const data = {
    'data-size': size,
    'data-wide': wide,
    ...(label === undefined ? {} : { 'aria-label': label }),
    ...(expanded === undefined ? {} : { 'aria-expanded': expanded }),
    ...(controls === undefined ? {} : { 'aria-controls': controls }),
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

/**
 * A button of the kit that opens the file picker of the browser (FRU-428), and hands the file chosen
 * to `onFile`. The input of the file is hidden: the button is what a person and a screen reader
 * reach. The same file chosen twice is handed twice.
 */
export function FilePick({
  accept,
  disabled = false,
  onFile,
  children,
}: {
  /** The types the picker offers, as `accept` takes them. */
  accept: string;
  disabled?: boolean;
  onFile: (file: File) => void;
  children: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);

  return (
    <>
      <Input
        ref={input}
        type="file"
        accept={accept}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file !== undefined) onFile(file);
        }}
      />
      <Button tone="outline" size="page" disabled={disabled} onClick={() => input.current?.click()}>
        {children}
      </Button>
    </>
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
  /**
   * The name a screen reader says, where the words are not enough alone: « Statuses » of a row is
   * « Statuses of acme.dev » (FRU-478). It starts with the words shown, as `label` of `Button`.
   */
  label?: string;
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
  label,
  children,
}: LinkButtonProps) {
  const data = { 'data-space': space, ...(label === undefined ? {} : { 'aria-label': label }) };
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
  /**
   * The keyboard of a phone, for a field that is not `type="url"` so that the screen judges what is
   * typed, or the digits of a number of days (FRU-462).
   */
  inputMode?: 'url' | 'numeric';
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
  /** Why what is typed cannot be kept: the field is invalid, and this sentence describes it. */
  error?: string;
  /** The input itself, for a screen that gives it focus back: the field a refusal names. */
  inputRef?: Ref<HTMLInputElement>;
  /** A field of code, such as a colour: drawn in the mono font, with no correction of what is typed. */
  code?: boolean;
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
  error,
  inputRef,
  code = false,
  ...input
}: FieldProps) {
  return (
    <TextField
      fullWidth
      isDisabled={disabled}
      isRequired={required}
      isInvalid={error !== undefined}
      className="kit-field"
      data-compact={compact}
      data-locked={locked}
      data-code={code}
    >
      <Label className={labelHidden ? 'sr-only' : ''}>{label}</Label>
      <Input
        {...input}
        {...(inputRef === undefined ? {} : { ref: inputRef })}
        {...(code ? { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' } : {})}
        readOnly={readOnly || locked}
      />
      {hint === undefined ? null : <Description>{hint}</Description>}
      {error === undefined ? null : <FieldError>{error}</FieldError>}
    </TextField>
  );
}

/** `drop`: the drop of a status before the label, in a list that chooses one (FRU-385). */
export type Option = { value: string; label: string; drop?: { status: Status; color?: string } };
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
      {option.drop === undefined ? (
        option.label
      ) : (
        <span className="inline-flex items-center gap-[8px]">
          <StatusDot status={option.drop.status} color={option.drop.color} />
          {option.label}
        </span>
      )}
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
  // An option with its own drop shows it in the button too, as the value: the button draws no second one.
  const chosen = options
    .flatMap((each) => ('options' in each ? each.options : [each]))
    .find((each) => each.value === value);
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
        {status === undefined || chosen?.drop !== undefined ? null : <StatusDot status={status} />}
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

type RadiosProps<Value extends string> = {
  label: string;
  value: Value;
  onChange?: (value: Value) => void;
  options: readonly { value: Value; label: string }[];
  /** The choice is made elsewhere: the radios show it, and take no press. */
  disabled?: boolean;
  /** Under the radios, and the description of the group for a screen reader. */
  hint?: string;
};

/** One choice among a few, as a plain list of radios: « Who can make an account ». */
export function Radios<Value extends string>({
  label,
  value,
  onChange,
  options,
  disabled = false,
  hint,
}: RadiosProps<Value>) {
  return (
    <RadioGroup
      value={value}
      isDisabled={disabled}
      onChange={(chosen) => onChange?.(chosen as Value)}
      className="kit-radios"
    >
      <Label>{label}</Label>
      {options.map((option) => (
        <Radio key={option.value} value={option.value} className="kit-radios__item">
          <Radio.Content>
            <Radio.Control>
              <Radio.Indicator />
            </Radio.Control>
            <Label>{option.label}</Label>
          </Radio.Content>
        </Radio>
      ))}
      {hint === undefined ? null : <Description>{hint}</Description>}
    </RadioGroup>
  );
}

type ToggleProps = {
  label: string;
  /** A line under the label. */
  hint?: string;
  /** The label in bold, as a row of a panel draws it. */
  strong?: boolean;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
};

type CheckboxProps = { label: string; checked: boolean; onChange: (checked: boolean) => void };

/**
 * A box to tick, as the checkbox of HeroUI: the box of 16 px, then its words, on a line of 40 px at
 * the least, so that it stands in a row of filters (« Only my notes »). Ink when it is ticked.
 *
 * The box is inside `Checkbox.Content`: in HeroUI 3 that is the label that takes the press. A box
 * drawn outside it does not tick (FRU-550).
 */
export function Checkbox({ label, checked, onChange }: CheckboxProps) {
  return (
    <HeroCheckbox isSelected={checked} onChange={onChange} className="kit-checkbox">
      <HeroCheckbox.Content>
        <HeroCheckbox.Control>
          <HeroCheckbox.Indicator />
        </HeroCheckbox.Control>
        <Label>{label}</Label>
      </HeroCheckbox.Content>
    </HeroCheckbox>
  );
}

type ChecksProps = {
  label: string;
  value: readonly string[];
  onChange: (value: string[]) => void;
  /** `detail`: a line beside the label, as who reads the notes of a site. */
  options: readonly { value: string; label: string; detail?: string; disabled?: boolean }[];
  hint?: string;
  /** What the group needs, said under it: the group reads as invalid to a screen reader. */
  error?: string;
  groupRef?: Ref<HTMLDivElement>;
};

/**
 * Several boxes to tick, under one label (FRU-462): the checkbox group of HeroUI, each box as
 * `Checkbox` draws it, with its hint, or its error, under the group.
 */
export function Checks({ label, value, onChange, options, hint, error, groupRef }: ChecksProps) {
  return (
    <CheckboxGroup
      value={[...value]}
      onChange={onChange}
      isInvalid={error !== undefined}
      className="kit-checks flex flex-col gap-[2px]"
      {...(groupRef === undefined ? {} : { ref: groupRef })}
    >
      <Label className="mb-[6px] text-small font-semibold">{label}</Label>
      {options.map((option) => (
        <HeroCheckbox
          key={option.value}
          value={option.value}
          isDisabled={option.disabled === true}
          className="kit-checkbox"
        >
          <HeroCheckbox.Content>
            <HeroCheckbox.Control>
              <HeroCheckbox.Indicator />
            </HeroCheckbox.Control>
            <span className="flex flex-wrap items-baseline gap-x-[10px]">
              <Label>{option.label}</Label>
              {option.detail === undefined ? null : <span className="text-hint text-muted">{option.detail}</span>}
            </span>
          </HeroCheckbox.Content>
        </HeroCheckbox>
      ))}
      {hint === undefined || error !== undefined ? null : <Description>{hint}</Description>}
      {error === undefined ? null : <FieldError>{error}</FieldError>}
    </CheckboxGroup>
  );
}

/**
 * A setting that is on or off, as the switch of HeroUI: the label first, the switch at the end of the
 * row. The track is inside the label of HeroUI, so a press on it turns the switch too. `hint` is a
 * second line under the label, inside the label as the mockup writes it.
 */
export function Toggle({ label, hint, strong = false, value, onChange, disabled = false }: ToggleProps) {
  return (
    <Switch
      isSelected={value}
      isDisabled={disabled}
      onChange={onChange}
      className={`kit-toggle w-full ${strong ? 'kit-toggle--strong' : ''}`}
    >
      <Switch.Content className="flex w-full flex-row-reverse items-center justify-between gap-4">
        {/* Ink when it is on, as the mockup draws it: the accent is the red of an alert. */}
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        <span className="min-w-0">
          <Label>{label}</Label>
          {hint === undefined ? null : <span className="block text-hint text-muted">{hint}</span>}
        </span>
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

/**
 * A read that failed (FRU-508): what did not load, that nothing is lost, and one way to read again.
 * Never « Nothing yet »: the screen does not know. The box of the mockup is 760 px inside its padding.
 */
export function LoadFailed({
  title,
  detail,
  retry,
  onRetry,
}: {
  /** « The notes did not load ». */
  title: string;
  /** « Fruitback did not answer. Your notes are safe. » */
  detail: string;
  /** The words of the button: « Try again ». */
  retry: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="box-content flex max-w-[760px] flex-wrap items-center justify-between gap-[16px] rounded-frame border border-control px-[32px] py-[28px]"
    >
      <div>
        <h2 className="mb-[4px] text-step leading-auto font-semibold">{title}</h2>
        <p className="text-body text-muted">{detail}</p>
      </div>
      <Button tone="outline" size="page" inset={18} onClick={onRetry}>
        {retry}
      </Button>
    </div>
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
 * beside it, because the grey of « to do » is 1.39:1 on white and a colour alone tells nothing to many people.
 */
export function StatusDot({
  status,
  size = 9,
  color,
}: {
  status: Status;
  size?: 9 | 10 | 11;
  /**
   * The colour of a status the team gave one (FRU-385), as `#rrggbb`: the drop takes it, over the
   * colour of its stage. The edge stays, so a light colour still shows on white (FRU-334).
   */
  color?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`kit-drop ${STATUS_COLOURS[status]}`}
      data-size={size}
      data-status={status}
      {...(color === undefined ? {} : { style: { background: color } })}
    />
  );
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
  /**
   * Under 640 px each row is a card, its cells one under the other, and the heads are for a screen
   * reader only (FRU-505). For a table whose first cell must stay on screen with the others.
   */
  stack?: boolean;
  /** `<thead>` and `<tbody>`. A cell with `data-align="end"` is aligned to the right. */
  children: ReactNode;
};

/**
 * A table in its frame. A table wider than the screen scrolls in the frame, and the page does not.
 * The frame takes focus, so a keyboard can scroll it (WCAG 2.1.1).
 */
export function DataTable({ label, minWidth, dense = false, hover = false, stack = false, children }: DataTableProps) {
  // A stacked table takes its width from the style sheet, which drops it under 640 px.
  const width = stack ? ({ '--table-min-width': `${minWidth}px` } as CSSProperties) : { minWidth };

  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="kit-table"
      data-dense={dense}
      data-hover={hover}
      data-stack={stack}
    >
      <table style={width}>{children}</table>
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
  /** The space between the parts of the panel: 24 px, or 22 px (« tight ») for the panels of the administration. */
  spacing?: 'normal' | 'tight';
  /**
   * An accordion under its row (FRU-403): no card of its own, and the title is said to a screen reader
   * only, as the row above already shows it.
   */
  flush?: boolean;
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
  spacing = 'normal',
  flush = false,
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
      data-spacing={spacing}
      {...(flush ? { 'data-flush': '' } : {})}
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

/**
 * The pages of one screen, as a row of links under its head (FRU-544): the settings of a workspace
 * and their page « AI ». The page on screen has `aria-current="page"` and is underlined. The row
 * scrolls in its frame on a narrow screen, and the page does not.
 */
export function SubNav({
  label,
  entries,
}: {
  /** What the row of links is, for a screen reader: « Workspace settings ». */
  label: string;
  entries: readonly { to: string; label: string; current: boolean }[];
}) {
  return (
    <nav aria-label={label} className="kit-subnav">
      <ul>
        {entries.map((entry) => (
          <li key={entry.to}>
            <Link to={entry.to} {...(entry.current ? { 'aria-current': 'page' as const } : {})}>
              {entry.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
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
  /**
   * Items under the choice, which choose nothing: « Workspace settings » under the workspaces. With
   * them, the choice and these items are two groups, and `choiceLabel` names the first one.
   */
  after?: readonly MenuItem[];
  choiceLabel?: string;
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
 *
 * The menu opens under its button. The menu of a picture ends at the right edge of its button
 * (FRU-407): that button closes a row, and a menu that started at its left edge went out of the
 * table. The menu of a button of the screen starts at its left edge, as the name of a workspace.
 */
export function Menu({
  items,
  chosen,
  after = [],
  choiceLabel,
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
      <Dropdown.Popover className="kit-menu" placement={trigger === 'icon' ? 'bottom end' : 'bottom start'}>
        <Dropdown.Menu
          onAction={(id) => onAction(String(id))}
          disabledKeys={[...items, ...after].filter((item) => item.disabled === true).map((item) => item.id)}
          {...(chosen === undefined || after.length > 0 ? {} : choice(chosen))}
        >
          {after.length === 0 ? (
            items.map((item) => menuItem(item, chosen !== undefined))
          ) : (
            <>
              <Dropdown.Section aria-label={choiceLabel} {...(chosen === undefined ? {} : choice(chosen))}>
                {items.map((item) => menuItem(item, chosen !== undefined))}
              </Dropdown.Section>
              <Dropdown.Section className="kit-menu__after">
                {after.map((item) => menuItem(item, false))}
              </Dropdown.Section>
            </>
          )}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** A menu or a group of it where one item is checked: the current one. */
function choice(chosen: string) {
  return { selectionMode: 'single' as const, selectedKeys: [chosen], disallowEmptySelection: true };
}

function menuItem(item: MenuItem, checkable: boolean) {
  return (
    <Dropdown.Item key={item.id} id={item.id} textValue={item.label} data-danger={item.danger === true}>
      {checkable ? <Dropdown.ItemIndicator /> : null}
      <span className="kit-menu__words">
        <Label>{item.label}</Label>
        {item.detail === undefined ? null : <Description>{item.detail}</Description>}
      </span>
    </Dropdown.Item>
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

/**
 * Sections that a page keeps folded under one line (FRU-538): a `<details>`, so the keyboard opens it
 * with Enter or Space, and a screen reader hears a button that is expanded or collapsed. `hint` says
 * what is inside while it is folded. `open` and `onToggle` let the page open it for an address with
 * the hash of a section inside it.
 */
export function Disclosure({
  id,
  title,
  hint,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  hint?: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <details id={id} open={open} onToggle={(event) => onToggle(event.currentTarget.open)} className="kit-disclosure">
      <summary className="kit-disclosure__summary">
        <svg aria-hidden="true" viewBox="0 0 24 24" className="kit-disclosure__chevron">
          <path
            d="M9 6l6 6-6 6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="flex min-w-0 flex-col">
          <span className="text-section font-bold">{title}</span>
          {hint === undefined ? null : <span className="text-small text-muted">{hint}</span>}
        </span>
      </summary>
      <div className="kit-disclosure__body">{children}</div>
    </details>
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
  /** Under the frame: what the page is. */
  caption?: ReactNode;
  /** The page, 620 px high. */
  children?: ReactNode;
};

/** The window of a browser, drawn around the preview of a site. */
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

/** A word as a search compares it: no case, no accent. « Équipe » holds « equi ». */
export function folded(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/** The options of the groups whose label holds the search, the groups left empty dropped. */
export function searched(groups: readonly OptionGroup[], search: string): OptionGroup[] {
  const wanted = folded(search.trim());

  return groups
    .map((group) => ({
      ...group,
      options: wanted === '' ? group.options : group.options.filter((each) => folded(each.label).includes(wanted)),
    }))
    .filter((group) => group.options.length > 0);
}

/** The first `limit` options of the groups, in their order, and how many are left after them. */
export function firstOf(groups: readonly OptionGroup[], limit: number): { groups: OptionGroup[]; left: number } {
  let room = limit;
  let left = 0;
  const shown: OptionGroup[] = [];
  for (const group of groups) {
    if (room <= 0) left += group.options.length;
    else {
      shown.push({ ...group, options: group.options.slice(0, room) });
      left += Math.max(0, group.options.length - room);
    }
    room -= group.options.length;
  }

  return { groups: shown, left };
}

/** The value of the last option of a `SearchChoice` that has more: it shows them, and chooses nothing. */
const MORE = 'kit-search-choice-more';

type SearchChoiceProps = {
  /** The name of the list: « Add a destination for acme.dev ». */
  label: string;
  /** The name of the search, and what its empty field says: « Search the destinations ». */
  searchLabel: string;
  /** The first option of the list, which chooses nothing: « Add a destination… ». */
  placeholder: string;
  groups: readonly OptionGroup[];
  /** An option chosen. */
  onChoose: (value: string) => void;
  /** The name of the button that empties the search. */
  clearLabel: string;
  /** The words of the list when no option holds the search. */
  noMatch: string;
  /** The words of the last option while some are not shown: « Show 50 more (70 left) ». */
  moreLabel: (more: number, left: number) => string;
  disabled?: boolean;
  /** How many options the list shows, and how many more « Show more » adds. */
  page?: number;
};

/**
 * A list with a search (FRU-438): a search field, as the one of the grid of the Sites screen, with a
 * cross that empties it, above a `Choice` that offers the options whose label holds what is typed,
 * with no case and no accent. The list shows `page` options, then a last option that shows `page`
 * more, so a GitHub account of hundreds of repositories does not draw them all at once.
 *
 * Measured on 2026-10-25: a combo box of HeroUI (react-aria 3.53) whose options change while its list
 * is open throws « childNodes is not supported » under React 19.3 in development, and its list stops
 * following what is typed. A `Select` changes its options only while it is closed.
 */
export function SearchChoice({
  label,
  searchLabel,
  placeholder,
  groups,
  onChoose,
  clearLabel,
  noMatch,
  moreLabel,
  disabled = false,
  page = 50,
}: SearchChoiceProps) {
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(page);
  const field = useRef<HTMLInputElement>(null);
  const found = searched(groups, search);
  const shown = firstOf(found, limit);
  const type = (value: string) => {
    setSearch(value);
    setLimit(page);
  };
  const empty = { value: placeholder, label: found.length === 0 ? noMatch : placeholder };

  return (
    <div className="kit-search-choice">
      <div className="kit-search-choice__search">
        <Field
          label={searchLabel}
          labelHidden
          compact
          type="search"
          placeholder={searchLabel}
          value={search}
          disabled={disabled}
          inputRef={field}
          onChange={(event) => type(event.target.value)}
        />
        {search === '' ? null : (
          <IconButton
            label={clearLabel}
            size="small"
            onClick={() => {
              type('');
              field.current?.focus();
            }}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </IconButton>
        )}
      </div>
      <Choice
        compact
        label={label}
        labelHidden
        value={empty.value}
        disabled={disabled || found.length === 0}
        onChange={(value) => {
          if (value === MORE) setLimit((current) => current + page);
          else if (value !== empty.value) onChoose(value);
        }}
        options={[
          empty,
          ...shown.groups,
          ...(shown.left === 0 ? [] : [{ value: MORE, label: moreLabel(Math.min(page, shown.left), shown.left) }]),
        ]}
      />
    </div>
  );
}
