import {
  Alert,
  Description,
  Drawer as HeroDrawer,
  Dropdown,
  FieldError,
  Header,
  Button as HeroButton,
  Checkbox as HeroCheckbox,
  CheckboxGroup,
  Chip as HeroChip,
  Input,
  Label,
  Link as HeroLink,
  ListBox,
  Modal,
  Radio,
  RadioGroup,
  Select,
  Switch,
  TextField,
  Tooltip,
} from '@heroui/react';
import {
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router';
import { Logo } from './logo';
import { STAGES, type Stage } from './stages';

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
type ControlSize = 'page' | 'panel' | 'small';

/** The tone of a button, as the variant HeroUI draws it with. */
const VARIANTS = {
  primary: 'primary',
  outline: 'outline',
  danger: 'danger-soft',
  quiet: 'ghost',
} as const satisfies Record<Tone, string>;

/**
 * The kit draws with Tailwind (FRU-678). A class of the kit is a utility, so it wins over a rule of
 * HeroUI, which is in the layer `components`. A screen places a component, and the kit draws it: a
 * class a screen gives a component sets its place (`mt-5`), never a property the kit sets.
 *
 * The `kit-*` names stay on the elements, with no style: the specs and the screens find a component
 * by them. A class with `!` beats a rule of `app.css` that is in no layer: the space of a button
 * (`white-space`), and the focus ring.
 *
 * `[&:hover]` and not `hover:`: Tailwind keeps `hover:` to a pointer that hovers, and the kit
 * changes a colour under any `:hover`, as it did.
 */

/** The pill and the rectangle of the mockup, of every size: what is the same in both. */
const BUTTON =
  'kit-button flex-none items-center justify-center gap-[8px] font-semibold no-underline cursor-pointer transform-none [transition:none] disabled:opacity-50 disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:cursor-not-allowed';

/** The action of a step: the one pill of a screen. White on it is 4.70:1, 6.47:1 under the pointer. */
const PRIMARY =
  'kit-button--primary rounded-[999px] border-0 border-none border-current bg-accent text-accent-foreground tracking-button [&:hover:not(:disabled,[aria-disabled=true])]:bg-accent-hover data-[hovered=true]:bg-accent-hover data-[pressed=true]:bg-accent-hover';

/** A control of the shape of a field: a provider to sign in with, « Try again », « Connect ». */
const OUTLINE =
  'kit-button--outline rounded-button border border-field-border bg-surface text-ink [&:hover:not(:disabled,[aria-disabled=true])]:border-ink [&:hover:not(:disabled,[aria-disabled=true])]:bg-subtle data-[hovered=true]:border-ink data-[hovered=true]:bg-subtle data-[pressed=true]:border-ink data-[pressed=true]:bg-subtle';

/** The padding at each end, by tone and size. */
const BUTTON_INSET = {
  primary: { page: 'px-[22px]', panel: 'px-[16px]', small: 'px-[14px]' },
  outline: { page: 'px-[18px]', panel: 'px-[16px]', small: 'px-[10px]' },
} as const satisfies Record<'primary' | 'outline', Record<ControlSize, string>>;

/**
 * The classes of a button of the mockup. Over its column (`wide`), its words can be a name somebody
 * typed: they take the lines they need, and the button grows, where a button of its own width would
 * make the page scroll sideways. A wide button of a panel keeps no padding above and under its words.
 */
function buttonClasses(tone: 'primary' | 'outline', size: ControlSize, wide: boolean, gap = 'gap-[8px]'): string {
  const block = wide
    ? `flex w-full h-auto ${BUTTON_WIDE[size]} text-center whitespace-normal! [overflow-wrap:anywhere]`
    : `inline-flex ${BUTTON_HEIGHT[size]} py-0 whitespace-nowrap`;

  return [
    BUTTON.replace('gap-[8px]', gap),
    tone === 'primary' ? PRIMARY : OUTLINE,
    BUTTON_INSET[tone][size],
    block,
    size === 'small' ? 'text-(length:--text-hint)' : 'text-(length:--text-small)',
    // After the size: the merge of HeroUI drops a line height that comes before a size.
    'leading-auto',
  ].join(' ');
}

const BUTTON_HEIGHT = {
  page: 'h-control',
  panel: 'h-control-panel',
  small: 'h-control-small',
} as const satisfies Record<ControlSize, string>;

const BUTTON_WIDE = {
  page: 'min-h-control py-[10px]',
  panel: 'min-h-control-panel py-0',
  small: 'min-h-control-small py-[6px]',
} as const satisfies Record<ControlSize, string>;

/**
 * The classes of a tone. « primary » and « outline » are the two buttons of the mockup. « quiet » and
 * « danger » are of before it, and stay as HeroUI draws them until their screens are drawn again.
 */
function toneClasses(tone: Tone, size: ControlSize, wide: boolean): string {
  if (tone === 'primary' || tone === 'outline') return buttonClasses(tone, size, wide);

  return 'rounded-full font-semibold';
}

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
  const classes = `${toneClasses(tone, size, wide)} ${className}`;
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

/**
 * A button that reads as a link. Its padding is its target: 37 px at the least (WCAG 2.5.8). Its
 * words can be a host: they wrap where they must. In a row of a table it takes the line of the table,
 * so that the row keeps the height of its text.
 */
const LINK =
  'kit-link gap-[6px] h-auto border-0 border-none border-current rounded-none bg-transparent bg-none text-ink font-semibold underline decoration-1 underline-offset-[3px] whitespace-normal! [overflow-wrap:anywhere] cursor-pointer transform-none [transition:none] [&:hover:not(:disabled,[aria-disabled=true])]:text-accent-strong data-[hovered=true]:text-accent-strong data-[pressed=true]:text-accent-strong disabled:opacity-50 disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:cursor-not-allowed';

/** The space of a link: its padding, and how it sits in its line. */
const LINK_SPACE = {
  tight:
    'inline-flex items-center py-[8px] px-0 text-(length:--text-small) leading-auto in-[.kit-table]:leading-[inherit]',
  flush:
    'inline-flex items-center py-[8px] px-0 -my-[8px] mx-0 text-(length:--text-small) leading-auto in-[.kit-table]:leading-[inherit]',
  normal:
    'inline-flex items-center py-[10px] px-0 text-(length:--text-small) leading-auto in-[.kit-table]:leading-[inherit]',
  loose:
    'inline-flex items-center py-[12px] px-0 text-(length:--text-small) leading-auto in-[.kit-table]:leading-[inherit]',
  // In a sentence: the words of the sentence, and no space of its own.
  inline: 'inline items-center p-0 [font-size:inherit] leading-[inherit]',
} as const satisfies Record<NonNullable<LinkButtonProps['space']>, string>;

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
  const classes = `${LINK} ${LINK_SPACE[space]}`;
  if (to !== undefined || href !== undefined) return anchor({ to, href, newTab }, classes, data, children);

  return (
    <HeroButton
      type="button"
      variant="ghost"
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

/** A button that is a picture: 36 px, or 32 px (« small »), its picture at 18 px. */
const ICON_BUTTON =
  'kit-icon-button inline-flex flex-none items-center justify-center p-0 border-0 border-none border-current rounded-(--field-radius) bg-transparent text-muted cursor-pointer transform-none [transition:none] [&:hover:not(:disabled,[aria-disabled=true])]:bg-chip data-[hovered=true]:bg-chip data-[pressed=true]:bg-chip disabled:opacity-50 disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:cursor-not-allowed [&_svg]:size-[18px] [&_svg]:m-0';

const ICON_BUTTON_SIZE = { chip: 'size-control-chip', small: 'size-control-small' } as const;

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
      className={`${ICON_BUTTON} ${ICON_BUTTON_SIZE[size]}`}
      data-size={size}
    >
      {children}
    </HeroButton>
  );
}

/** As tall as a small icon button, as wide as its number, in the words of the list. */
const PAGE_NUMBER =
  'kit-page-number inline-flex flex-none items-center justify-center min-w-control-small h-control-small px-[6px] py-0 border-0 border-none border-current rounded-(--field-radius) text-(length:--text-small) tabular-nums transform-none [transition:none]';

/**
 * The number of a page of a list (FRU-587): a small square button, the page shown in ink. The page
 * shown is `aria-current` and stays a button, which a press does nothing with: the focus of a press on
 * a number stays on it once its page is drawn.
 */
export function PageNumber({
  label,
  current,
  onClick,
  children,
}: {
  /** « Page 3 »: the number alone says nothing to a screen reader that reads the buttons. */
  label: string;
  current: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <HeroButton
      type="button"
      variant="ghost"
      aria-label={label}
      aria-current={current ? 'page' : undefined}
      onPress={() => {
        if (!current) onClick();
      }}
      className={`${PAGE_NUMBER} ${current ? 'bg-ink text-surface font-semibold cursor-default' : 'bg-transparent text-muted cursor-pointer [&:hover]:bg-chip [&:hover]:text-ink data-[hovered=true]:bg-chip data-[hovered=true]:text-ink'}`}
    >
      {children}
    </HeroButton>
  );
}

type IconLinkProps = {
  /** Where the link goes, said to a screen reader: its picture says it to the eye alone. */
  label: string;
  href: string;
  /** What the tooltip shows, under the pointer and under the focus: the address, for a link out. */
  tip: string;
  /** The picture: an `svg` with `aria-hidden`. */
  children: ReactNode;
};

/**
 * A link that is a picture, opened in a new tab, with a tooltip of HeroUI (FRU-546): « Open the page
 * of the note » in the table of the notes, its address in the tooltip. 32 px, as a small
 * `IconButton`.
 */
export function IconLink({ label, href, tip, children }: IconLinkProps) {
  return (
    <Tooltip delay={300} closeDelay={0}>
      <HeroLink
        href={href}
        target="_blank"
        rel="noreferrer"
        aria-label={label}
        className="kit-icon-link inline-flex flex-none items-center justify-center size-control-small rounded-(--field-radius) text-muted [text-decoration:none] [&:hover]:bg-chip [&:hover]:text-ink data-[hovered=true]:bg-chip data-[hovered=true]:text-ink [&_svg]:size-[16px]"
      >
        {children}
      </HeroLink>
      <Tooltip.Content placement="top" className={TIP}>
        {tip}
      </Tooltip.Content>
    </Tooltip>
  );
}

/** A tooltip: ink, 12 px, under 360 px; an address breaks anywhere rather than overflow. */
const TIP =
  'kit-tip max-w-[min(360px,calc(100vw-32px))] px-[8px] py-[6px] rounded-[6px] bg-ink text-page text-(length:--text-tiny) leading-[1.4] [overflow-wrap:anywhere] [word-break:normal] [box-shadow:none]';

type TipProps = {
  /** What the tooltip shows: the words whole, and what the picture means. */
  tip: string;
  className?: string;
  /** What is drawn: a picture and words cut to their room, and what a screen reader says of them. */
  children: ReactNode;
};

/**
 * Words cut to their room, whole in a tooltip of HeroUI under the pointer (FRU-553): the author of a
 * note, with the icon of their role. The words are in the page whole (a cut is CSS), so a screen
 * reader says them all; the children give it what the picture means. The trigger is no control:
 * out of the order of the keyboard, and a `group`, where HeroUI makes it a button that does nothing
 * (review of the columns, FRU-553).
 */
export function Tip({ tip, className = '', children }: TipProps) {
  return (
    <Tooltip delay={300} closeDelay={0}>
      <Tooltip.Trigger
        role="group"
        tabIndex={-1}
        className={`kit-tip-trigger inline-flex max-w-full min-w-0 items-center gap-[6px] rounded-[4px] cursor-default ${className}`}
      >
        {children}
      </Tooltip.Trigger>
      <Tooltip.Content placement="top" className={TIP}>
        {tip}
      </Tooltip.Content>
    </Tooltip>
  );
}

/** How long a finger holds a cut link before its tooltip opens: the long press of Android. */
const LONG_PRESS_MS = 500;
/** How far a finger moves before a long press is a scroll instead. */
const LONG_PRESS_SLOP = 10;
/**
 * How long after the finger of a long press is lifted its click is ignored. The click of a touch
 * comes right after its `pointerup`; any later click is a new gesture and follows the link.
 */
const LONG_PRESS_CLICK_MS = 1000;

type CutLinkProps = {
  to: string;
  /** The words of the link. They are in the page whole, so a screen reader says them all. */
  children: string;
  /** The heading that holds the link. The trigger of the tooltip is a `div`, so it goes around the heading. */
  heading?: 'h2' | 'h3';
  /** The classes of the heading: the size and the weight of the words. */
  className?: string;
  /** The classes of the link: its colour, its hover and its focus ring. */
  linkClassName?: string;
};

/**
 * A link on one line, cut with « … » to its room, and whole in a tooltip only when it is cut
 * (FRU-585: the address of a site on its card). The tooltip opens:
 * - when the pointer rests on it, as `Tip`;
 * - when the keyboard gives the link focus (`:focus-visible`), and Escape closes it;
 * - on a long press of a finger (500 ms). The click that ends that press does not follow the link;
 *   only the click within 1 s of its `pointerup` is ignored, so no later tap, click or Enter is lost.
 *   The next press anywhere closes the tooltip.
 *
 * The link has `overflow: hidden`, not its heading: an ancestor that clips cuts the focus ring.
 */
export function CutLink({ to, children, heading: Heading = 'h2', className = '', linkClassName = '' }: CutLinkProps) {
  const ref = useRef<HTMLAnchorElement>(null);
  const [cut, setCut] = useState(false);
  const [open, setOpen] = useState(false);
  // The press of a finger in progress: where it started, and whether it was held long enough to open
  // the tooltip. `ignoreClickUntil` is the end of the window in which its click is ignored.
  const press = useRef<{
    timer?: ReturnType<typeof setTimeout>;
    x: number;
    y: number;
    touch: boolean;
    held: boolean;
    ignoreClickUntil: number;
  }>({ x: 0, y: 0, touch: false, held: false, ignoreClickUntil: 0 });

  // The link is cut when its words are wider than its box. The box follows the card, and a font that
  // loads late changes the width of the words.
  useLayoutEffect(() => {
    const link = ref.current;
    if (link === null) return undefined;
    const measure = () => setCut(link.scrollWidth > link.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(link);
    void document.fonts?.ready.then(measure);

    return () => observer.disconnect();
  }, [children]);

  // A tooltip that a finger opened closes on the next press, anywhere.
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: Event) => {
      if (event.target instanceof Node && ref.current?.contains(event.target) === true) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', close, true);

    return () => document.removeEventListener('pointerdown', close, true);
  }, [open]);

  useEffect(() => () => clearTimeout(press.current.timer), []);

  const stop = () => {
    clearTimeout(press.current.timer);
    press.current.timer = undefined;
  };
  const hold = () => {
    stop();
    press.current.held = true;
    setOpen(true);
  };

  return (
    <Tooltip delay={300} closeDelay={0} isOpen={open && cut} onOpenChange={setOpen}>
      <Tooltip.Trigger role="group" tabIndex={-1} className="block min-w-0 cursor-auto">
        <Heading className={className}>
          <Link
            ref={ref}
            to={to}
            className={`inline-block max-w-full truncate align-top ${cut ? '[-webkit-touch-callout:none]' : ''} ${linkClassName}`}
            onFocus={(event) => {
              if (event.currentTarget.matches(':focus-visible')) setOpen(true);
            }}
            onBlur={() => setOpen(false)}
            onPointerDown={(event) => {
              stop();
              press.current = {
                x: event.clientX,
                y: event.clientY,
                touch: event.pointerType === 'touch',
                held: false,
                ignoreClickUntil: 0,
              };
              if (press.current.touch && cut) press.current.timer = setTimeout(hold, LONG_PRESS_MS);
            }}
            onPointerMove={(event) => {
              const moved = Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y);
              if (moved > LONG_PRESS_SLOP) stop();
            }}
            onPointerUp={() => {
              stop();
              if (press.current.held) press.current.ignoreClickUntil = performance.now() + LONG_PRESS_CLICK_MS;
              press.current.held = false;
            }}
            // A press that the browser takes for a scroll or a menu ends with no click: nothing to ignore.
            onPointerCancel={() => {
              stop();
              press.current.held = false;
            }}
            // Android opens the menu of a link on a long press: on a cut link, the tooltip opens instead.
            onContextMenu={(event) => {
              if (!press.current.touch || !cut) return;
              event.preventDefault();
              hold();
            }}
            onClick={(event) => {
              // Only a click of a pointer: Enter gives `detail` 0, and always follows the link.
              const ignored = event.detail > 0 && performance.now() < press.current.ignoreClickUntil;
              press.current.ignoreClickUntil = 0;
              if (ignored) event.preventDefault();
            }}
          >
            {children}
          </Link>
        </Heading>
      </Tooltip.Trigger>
      <Tooltip.Content placement="top" className={TIP}>
        {children}
      </Tooltip.Content>
    </Tooltip>
  );
}

type FieldProps = {
  label: string;
  /** The label is for a screen reader only: the placeholder shows what to type. */
  labelHidden?: boolean;
  hint?: string;
  value?: string;
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
  /** `date`: a day of the calendar of the browser, `YYYY-MM-DD` (FRU-653). */
  type?: 'text' | 'email' | 'url' | 'password' | 'search' | 'date';
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
  /**
   * The field asks for the address of another person, or searches among people: no browser fill and
   * no password manager. LastPass draws its icon in such a field and makes it 5 px higher (FRU-540).
   * Never on a field where somebody types their own address or password.
   */
  someoneElse?: boolean;
};

/** What turns off the fill of the browser and of LastPass, 1Password and Bitwarden in one field. */
const NO_PASSWORD_MANAGER = {
  autoComplete: 'off',
  'data-lpignore': 'true',
  'data-1p-ignore': 'true',
  'data-bwignore': 'true',
} as const;

/** A field and a list: the label, the control, the hint, 6 px apart. */
const FIELD = 'kit-field flex flex-col gap-[6px] min-w-0';
const FIELD_LABEL = 'text-(length:--text-label) leading-(--text-label--line-height) font-semibold text-ink';
const FIELD_HINT = 'text-(length:--text-hint) leading-(--text-hint--line-height) text-muted';
/** A field whose value cannot be kept (FRU-371): the strong red, and the reason under it. */
const FIELD_ERROR = 'text-(length:--text-hint) leading-(--text-hint--line-height) text-accent-strong';

/** What a text field and the button of a list share: the box of a control, flat. */
const CONTROL = 'box-border min-h-0 border rounded-(--field-radius) [box-shadow:none] font-normal [transition:none]';
/** The colours of a control a person can change. */
const CONTROL_COLOURS = 'border-field-border bg-field text-field-foreground';

/**
 * The input of a `Field`: 44 px, or 40 px (« compact »). A value set elsewhere (« locked ») reads in
 * the soft ink on the subtle tint. An invalid one has a thicker edge of the strong red.
 */
function inputClasses(compact: boolean, locked: boolean, code: boolean): string {
  return [
    CONTROL,
    compact ? 'h-control-panel px-[12px] text-(length:--text-small)' : 'h-control px-[14px] text-(length:--text-body)',
    'leading-auto',
    'py-0',
    locked ? 'border-line bg-subtle text-ink-soft' : CONTROL_COLOURS,
    code ? 'font-mono' : '',
    'aria-invalid:border-accent-strong aria-invalid:[box-shadow:0_0_0_1px_var(--color-accent-strong)] disabled:opacity-50 disabled:cursor-not-allowed',
  ].join(' ');
}

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
  someoneElse = false,
  ...input
}: FieldProps) {
  return (
    <TextField
      fullWidth
      isDisabled={disabled}
      isRequired={required}
      isInvalid={error !== undefined}
      className={FIELD}
      data-compact={compact}
      data-locked={locked}
      data-code={code}
    >
      {/* No mark on a required field (FRU-168): the mockup draws none. It stays required for the browser. */}
      <Label className={`${FIELD_LABEL} after:content-none ${labelHidden ? 'sr-only' : ''}`}>{label}</Label>
      {/*
       * A password manager puts its icon next to the input, in its parent. LastPass adds an empty
       * element, and the gap of the field then makes the field 6 px higher (FRU-540). In this block,
       * that element takes no room.
       */}
      <div className="kit-field__control block min-w-0">
        <Input
          className={inputClasses(compact, locked, code)}
          {...input}
          {...(inputRef === undefined ? {} : { ref: inputRef })}
          {...(code ? { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' } : {})}
          {...(someoneElse ? NO_PASSWORD_MANAGER : {})}
          readOnly={readOnly || locked}
        />
      </div>
      {hint === undefined ? null : <Description className={FIELD_HINT}>{hint}</Description>}
      {error === undefined ? null : <FieldError className={FIELD_ERROR}>{error}</FieldError>}
    </TextField>
  );
}

/** `drop`: the drop of a status before the label, in a list that chooses one (FRU-385). */
export type Option = { value: string; label: string; drop?: { status: Stage; color?: string } };
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
  status?: Stage;
  /**
   * The button is the drop of the chosen status alone, 28 px, with no border (FRU-551): the status of
   * a row of the notes, whose group already says it in words. Its name still says the status.
   */
  bare?: boolean;
};

/** The label of an option: cut to the width of the list, no wider than 360 px nor than the screen. */
const OPTION_LABEL = 'kit-option-label block min-w-0 truncate';

/**
 * The button of a `Choice`. A compact list is 40 px. A list of statuses is 38 px, its drop 12 px from
 * the edge (its border counted) and its word 9 px after. A bare one is the drop of its status alone
 * (FRU-551): 28 px, no border, tinted under the pointer as an icon button.
 */
function triggerClasses(compact: boolean, status: boolean, bare: boolean): string {
  if (bare)
    return `${CONTROL} items-center justify-center size-[28px] p-0 border-transparent bg-transparent text-field-foreground ${status ? 'gap-[9px]' : ''} ${compact || status ? 'text-(length:--text-small)' : 'text-(length:--text-body)'} leading-auto [&:hover]:bg-chip data-[hovered=true]:bg-chip data-[disabled=true]:opacity-50 data-[disabled=true]:cursor-not-allowed`;
  const size = status
    ? 'gap-[9px] h-control-row pl-[11px] pr-[28px] py-0 text-(length:--text-small)'
    : `${compact ? 'h-control-panel text-(length:--text-small)' : 'h-control text-(length:--text-body)'} pl-[12px] pr-[28px] py-0`;

  return `${CONTROL} ${CONTROL_COLOURS} items-center ${size} leading-auto data-[disabled=true]:opacity-50 data-[disabled=true]:cursor-not-allowed`;
}

/**
 * The chosen value takes the type of its button, as a field does (FRU-412), and a long one is cut with
 * « … » before the chevron (FRU-549). The value of a bare list is said to a screen reader only.
 */
const VALUE = 'flex-auto min-w-0 overflow-hidden text-ellipsis whitespace-nowrap [font-size:inherit] leading-auto';
const BARE_VALUE =
  'flex-none min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0px] leading-auto [&>span]:gap-0';

function item(option: Option) {
  // FRU-549: a long label is cut to the width of the list, with « … », and whole under the pointer.
  return (
    <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
      {option.drop === undefined ? (
        <span className={OPTION_LABEL} title={option.label}>
          {option.label}
        </span>
      ) : (
        <span className="inline-flex min-w-0 items-center gap-[8px]">
          <StatusDot status={option.drop.status} color={option.drop.color} />
          <span className={OPTION_LABEL} title={option.label}>
            {option.label}
          </span>
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
  bare = false,
}: ChoiceProps) {
  // An option with its own drop shows it in the button too, as the value: the button draws no second one.
  const chosen = options
    .flatMap((each) => ('options' in each ? each.options : [each]))
    .find((each) => each.value === value);
  return (
    <Select
      fullWidth={!bare}
      isDisabled={disabled}
      className={`${FIELD} ${bare ? 'w-auto' : ''}`}
      data-compact={compact}
      data-bare={bare}
      data-status={status !== undefined}
      value={value}
      onChange={(chosen) => {
        if (typeof chosen === 'string') onChange(chosen);
      }}
    >
      <Label className={`${FIELD_LABEL} after:content-none ${labelHidden ? 'sr-only' : ''}`}>{label}</Label>
      <Select.Trigger className={triggerClasses(compact, status !== undefined, bare)}>
        {status === undefined || chosen?.drop !== undefined ? null : <StatusDot status={status} />}
        <Select.Value className={bare ? BARE_VALUE : VALUE} />
        <Select.Indicator className={bare ? 'hidden' : ''} />
      </Select.Trigger>
      {hint === undefined ? null : <Description className={FIELD_HINT}>{hint}</Description>}
      <Select.Popover className="kit-select-popover max-w-[min(360px,calc(100vw-32px))]">
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

/**
 * One choice among a few, each with a line that says what it means: the radio cards of the mockup.
 *
 * FRU-569: a press anywhere on a card chooses it. `Radio.Content` is the label of HeroUI, so it holds
 * the detail too and fills the card. The detail is hidden from the name of the radio, and stays its
 * description.
 */
export function Pick<Value extends string>({ label, value, onChange, options }: PickProps<Value>) {
  return (
    <RadioGroup
      value={value}
      onChange={(chosen) => onChange(chosen as Value)}
      className="kit-pick flex flex-col gap-[8px] min-w-0"
    >
      {/* The question is 8 px over the first card, as the cards are 8 px apart. */}
      <Label className={FIELD_LABEL}>{label}</Label>
      {options.map((option) => (
        <Radio
          key={option.value}
          value={option.value}
          className="kit-pick__card group/pick w-full m-0 border border-line rounded-box cursor-pointer data-selected:border-ink"
        >
          {/*
           * The radio and the label on the first row, the detail under the label. The words start 30 px
           * after the radio: its 16 px, then 14 px. The row of the radio keeps its 19 px: the 16 px of the
           * radio and the 3 px the mockup puts over it.
           */}
          <Radio.Content className="grid grid-cols-[auto_minmax(0,1fr)] grid-rows-[minmax(19px,auto)] items-center gap-x-[14px] gap-y-[2px] w-full min-h-[19px] px-[16px] py-[14px] rounded-[inherit]">
            {/* Ink when it is chosen, as the switch: the accent is the red of an alert. */}
            <Radio.Control className="group-data-selected/pick:bg-ink">
              <Radio.Indicator />
            </Radio.Control>
            <Label className="text-(length:--text-body) font-semibold leading-auto text-ink">{option.label}</Label>
            <Description aria-hidden="true" className={`[grid-column:2] ${FIELD_HINT}`}>
              {option.detail}
            </Description>
          </Radio.Content>
        </Radio>
      ))}
    </RadioGroup>
  );
}

type RadiosProps<Value extends string> = {
  label: string;
  value: Value;
  onChange?: (value: Value) => void;
  /** `swatch`: a colour drawn before the label, as the colour of a label of a task (FRU-654). */
  options: readonly { value: Value; label: string; swatch?: string }[];
  /** The choice is made elsewhere: the radios show it, and take no press. */
  disabled?: boolean;
  /** Under the radios, and the description of the group for a screen reader. */
  hint?: string;
};

/** The words of a radio of a plain list: 15 px on the line of a body text. */
const RADIO_LABEL = 'text-(length:--text-body) leading-(--text-body--line-height) font-normal text-ink';

/** One choice among a few, as a plain list of radios: « Who can create an account ». */
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
      className="kit-radios flex flex-col gap-[8px] min-w-0"
    >
      <Label className="mb-[8px] text-(length:--text-body) font-semibold leading-auto text-ink">{label}</Label>
      {options.map((option) => (
        <Radio key={option.value} value={option.value} className="kit-radios__item group/radio m-0">
          <Radio.Content className="gap-[10px]">
            <Radio.Control className="group-data-selected/radio:bg-ink">
              <Radio.Indicator />
            </Radio.Control>
            {option.swatch === undefined ? (
              <Label className={RADIO_LABEL}>{option.label}</Label>
            ) : (
              <span className="inline-flex items-center gap-[8px]">
                <Swatch colour={option.swatch} />
                <Label className={RADIO_LABEL}>{option.label}</Label>
              </span>
            )}
          </Radio.Content>
        </Radio>
      ))}
      {hint === undefined ? null : <Description className={FIELD_HINT}>{hint}</Description>}
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
 * A box to tick: 16 px, the border of a control, ink when ticked or mixed; its words at 14 px, 8 px
 * after. The content is the label that takes the press: it holds the box and the words, on a line of
 * 40 px at the least. In a list (`list`), the box takes the width of the list and its words wrap: a
 * long site name goes to the next line, and never past the edge of a phone. In the frame of a
 * `SelectBox` (`bare`), the line is the frame's.
 */
function checkboxClasses({ list = false, bare = false }: { list?: boolean; bare?: boolean } = {}) {
  const width = list ? 'max-w-full min-w-0' : '';
  const line = bare ? 'min-h-0' : 'min-h-control-panel';

  return {
    root: `kit-checkbox group/check inline-flex flex-row flex-nowrap items-center ${line} ${width} cursor-pointer`,
    content: `flex-row flex-nowrap items-center gap-[8px] ${line} ${width} m-0 cursor-pointer`,
    // HeroUI paints a ticked box with a layer in its accent, over the background: ink here too.
    control:
      'size-[16px] border border-field-border rounded-[3px] bg-surface [box-shadow:none] before:bg-ink group-data-[selected=true]/check:border-ink group-data-[selected=true]/check:bg-ink group-data-[selected=true]/check:text-surface group-data-[indeterminate=true]/check:border-ink group-data-[indeterminate=true]/check:bg-ink group-data-[indeterminate=true]/check:text-surface',
    label: `text-ink text-(length:--text-small) font-normal ${list ? 'whitespace-normal [overflow-wrap:anywhere]' : 'whitespace-nowrap'}`,
  };
}

/** A colour drawn as a square, with the edge of a status: 18 px, or 10 px (« small »). */
export function Swatch({
  colour,
  small = false,
  className = '',
}: {
  colour?: string;
  small?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`kit-swatch ${small ? 'kit-swatch-small size-[10px] rounded-[3px]' : 'size-[18px] rounded-[5px]'} inline-block flex-none [box-shadow:0_0_0_1px_var(--color-status-edge)] ${className}`}
      style={{ background: colour }}
    />
  );
}

/**
 * A box to tick, as the checkbox of HeroUI: the box of 16 px, then its words, on a line of 40 px at
 * the least, so that it stands in a row of filters (« Only my notes »). Ink when it is ticked.
 *
 * The box is inside `Checkbox.Content`: in HeroUI 3 that is the label that takes the press. A box
 * drawn outside it does not tick (FRU-550).
 */
export function Checkbox({ label, checked, onChange }: CheckboxProps) {
  const classes = checkboxClasses();

  return (
    <HeroCheckbox isSelected={checked} onChange={onChange} className={classes.root}>
      <HeroCheckbox.Content className={classes.content}>
        <HeroCheckbox.Control className={classes.control}>
          <HeroCheckbox.Indicator />
        </HeroCheckbox.Control>
        <Label className={classes.label}>{label}</Label>
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
  const classes = checkboxClasses({ list: true });

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
          className={classes.root}
        >
          <HeroCheckbox.Content className={classes.content}>
            <HeroCheckbox.Control className={classes.control}>
              <HeroCheckbox.Indicator />
            </HeroCheckbox.Control>
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-[10px]">
              <Label className={classes.label}>{option.label}</Label>
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
      className={`kit-toggle group/toggle w-full ${strong ? 'kit-toggle--strong' : ''} ${disabled ? 'opacity-100 cursor-not-allowed' : ''}`}
    >
      {/* A switch that cannot change: its control is dimmed, and its words stay as they read. */}
      <Switch.Content
        className={`flex w-full flex-row-reverse items-center justify-between gap-4 ${disabled ? 'opacity-100 cursor-not-allowed' : ''}`}
      >
        {/* Ink when it is on, as the mockup draws it: the accent is the red of an alert. One movement of 220 ms. */}
        <Switch.Control className="relative w-[40px] h-[24px] overflow-visible rounded-[999px] bg-field-border [box-shadow:none] [transition:background-color_200ms] group-data-[selected=true]/toggle:bg-ink group-data-[disabled=true]/toggle:opacity-50 motion-reduce:[transition:none]">
          <Switch.Thumb className="absolute top-[3px] left-[3px] size-[18px] m-0 rounded-[50%] bg-surface [box-shadow:var(--shadow-thumb)] opacity-100 [transition:transform_var(--duration-fast)_var(--ease-settle)] group-data-[selected=true]/toggle:[transform:translateX(16px)] motion-reduce:[transition:none]" />
        </Switch.Control>
        <span className="min-w-0">
          <Label
            className={`text-(length:--text-small) leading-(--text-small--line-height) text-ink ${strong ? 'font-semibold' : 'font-normal'} ${disabled ? 'opacity-100 cursor-not-allowed' : ''}`}
          >
            {label}
          </Label>
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

/**
 * A problem said where it happened, with what to do about it (FRU-163). HeroUI draws every alert as
 * a white card with muted text, and tells its status with an icon and a title that the kit does not
 * use. So the danger of the theme is on the text and on the border, and the card is tinted with it.
 * The text on that tint is 5.84:1.
 */
export function Problem({ children }: { children: ReactNode }) {
  return (
    <Alert
      status="danger"
      role="alert"
      className="[border:1px_solid_color-mix(in_srgb,var(--danger)_35%,var(--surface))] rounded-box [background:color-mix(in_srgb,var(--danger)_6%,var(--surface))] [box-shadow:none]"
    >
      <Alert.Content>
        <Alert.Description className="text-danger">{children}</Alert.Description>
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
  /** Why, with what to do, then what is not lost: « Fruitback hit an error. Try again in a moment. Your notes are safe. » */
  detail: ReactNode;
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
    <span
      className={`kit-avatar flex flex-none items-center justify-center box-border ${size === 'small' ? 'size-[28px]' : 'size-[32px]'} border border-line rounded-[999px] ${pending ? 'bg-surface text-muted' : 'bg-avatar text-surface'} text-(length:--text-hint) font-bold leading-auto`}
      data-size={size}
      data-pending={pending}
      aria-hidden="true"
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

/** The colour of a status. The class names are whole, so Tailwind finds them. */
const STATUS_COLOURS = {
  new: 'bg-status-new',
  todo: 'bg-status-todo',
  progress: 'bg-status-progress',
  done: 'bg-status-done',
  closed: 'bg-status-closed',
} as const satisfies Record<Stage, string>;

/** The drop of a pin: the shape of a status, of the entry of the rail, of a success. */
const DROP = 'kit-drop inline-block flex-none rounded-[50%_50%_50%_0] [transform:rotate(-90deg)]';
const DROP_SIZE = { 9: 'size-[9px]', 10: 'size-[10px]', 11: 'size-[11px]' } as const;

/** A drop of a colour a screen gives: the one of « done » on the rail, the entry on screen. */
export function Drop({ size = 9, className = '' }: { size?: 9 | 10 | 11; className?: string }) {
  return <span aria-hidden="true" className={`${DROP} ${DROP_SIZE[size]} ${className}`} data-size={size} />;
}

/**
 * The drop of a status. It is a picture for the eye only: the word of the status is always written
 * beside it, because the grey of « to do » is 1.39:1 on white and a colour alone tells nothing to many people.
 */
export function StatusDot({
  status,
  size = 9,
  color,
}: {
  status: Stage;
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
      // The edge, as in the widget and the extension: three statuses are light greys and a mango (FRU-334).
      className={`${DROP} ${DROP_SIZE[size]} [box-shadow:0_0_0_1px_var(--color-status-edge)] ${STATUS_COLOURS[status]}`}
      data-size={size}
      data-status={status}
      {...(color === undefined ? {} : { style: { background: color } })}
    />
  );
}

type StatusBarProps = {
  /** How many notes have each status. A status with none takes no room. */
  counts: Readonly<Record<Stage, number>>;
  /** The counts in words, e.g. « 3 new, 2 to do, 4 in progress, 2 done, 1 closed »: the bar is a picture. */
  label: string;
  /** 128 px in a table, 96 px on a tinted track (« short »), or the width of its column (« full »). */
  width?: 'table' | 'short' | 'full';
};

const STATUS_BAR_WIDTH = { table: 'w-[128px]', short: 'w-[96px] bg-chip', full: 'w-full' } as const;

/**
 * The statuses of the notes of a site, as one bar. Each segment has the edge of a status: the light
 * ones are under 3:1 on white (FRU-334).
 */
export function StatusBar({ counts, label, width = 'table' }: StatusBarProps) {
  return (
    <span
      role="img"
      aria-label={label}
      className={`kit-status-bar flex flex-none gap-[2px] h-[8px] overflow-hidden rounded-[999px] ${STATUS_BAR_WIDTH[width]}`}
      data-width={width}
    >
      {STAGES.filter((status) => counts[status] > 0).map((status) => (
        <span
          key={status}
          className={`${STATUS_COLOURS[status]} [box-shadow:inset_0_0_0_1px_var(--color-status-edge)] first:rounded-[999px_0_0_999px] last:rounded-[0_999px_999px_0] only:rounded-[999px]`}
          style={{ flexGrow: counts[status], flexBasis: 0 }}
        />
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

/**
 * A filter that is on or off: a button with `aria-pressed`. Its count is said in a lighter weight. A
 * filter of a problem is the accent on white, 4.70:1. A filter that is on is ink.
 */
export function FilterChip({ pressed, onChange, count, alert = false, children }: FilterChipProps) {
  const chipColours = pressed
    ? 'border-ink bg-ink text-surface'
    : `border-field-border bg-surface ${alert ? 'text-accent' : 'text-ink'} [&:hover]:border-ink data-[hovered=true]:border-ink`;
  let countColour = alert ? 'text-accent' : 'text-muted';
  if (pressed) countColour = 'text-rail-text';

  return (
    <HeroButton
      type="button"
      variant="outline"
      aria-pressed={pressed}
      onPress={() => onChange(!pressed)}
      className={`kit-chip inline-flex flex-none items-center gap-[8px] h-control-chip px-[14px] py-0 border rounded-[999px] text-(length:--text-hint) font-semibold leading-auto whitespace-nowrap cursor-pointer transform-none [transition:none] ${chipColours}`}
      data-alert={alert}
    >
      {children}
      {count === undefined ? null : (
        <span className={`kit-chip__count font-normal tabular-nums ${countColour}`}>{count}</span>
      )}
    </HeroButton>
  );
}

type DataTableProps = {
  /** What the table lists. It names the region, which a keyboard scrolls when the table is wider. */
  label: string;
  /** The width under which the table scrolls in its frame, in pixels, or with `stack` is cards. */
  minWidth: number;
  /** 12 px above and under a cell, and not 14: the rows of people. */
  dense?: boolean;
  /** A row is tinted under the pointer: the rows that open something. */
  hover?: boolean;
  /**
   * Each row is a card where the frame is narrower than `minWidth`, its cells one under the other, and
   * the heads are for a screen reader only (FRU-505, FRU-586). For a table whose first cell must stay
   * on screen with the others: the frame never scrolls sideways.
   */
  stack?: boolean;
  /**
   * With `stack`: the heads stay at the top of the window while the page scrolls (FRU-586). The head
   * of the columns, then the head of the group of the rows under it (`.kit-table-group`), until the
   * group ends. They stay under `--kit-pinned-top`, the height of what the screen pins above them.
   */
  pinned?: boolean;
  /** `<thead>` and `<tbody>`. A cell with `data-align="end"` is aligned to the right. */
  children: ReactNode;
};

/**
 * What the frame of a table draws in the rows a screen writes: the screen owns its cells, so these are
 * variants of the frame. A head is one line (FRU-401). The cells at the ends are 20 px from the frame.
 * A row whose panel is open (`data-chosen`), or that is selected, keeps its tint under the pointer.
 */
const TABLE_CELLS = [
  '[&_th]:px-[16px] [&_th]:py-[12px] [&_th]:[border-bottom:1px_solid_var(--color-line)] [&_th]:text-muted [&_th]:text-(length:--text-hint) [&_th]:font-semibold [&_th]:text-left [&_th]:whitespace-nowrap',
  '[&_td]:px-[16px] [&_td]:[border-bottom:1px_solid_var(--color-line)]',
  '[&_:is(th,td):first-child]:pl-[20px] [&_:is(th,td):last-child]:pr-[20px]',
  '[&_tbody_tr[data-chosen=true]]:bg-chip [&_tr[data-selected=true]>td]:bg-chip',
  '[&_[data-align=end]]:text-right',
  // The head of a group of rows (FRU-551): a band of the subtle tint, the words of the group in ink.
  '[&_.kit-table-group_th]:py-[8px] [&_.kit-table-group_th]:bg-subtle [&_.kit-table-group_th]:text-ink [&_.kit-table-group_th]:text-(length:--text-small)',
].join(' ');

/**
 * A stacked table (FRU-505, FRU-586): one card per row where the frame is narrower than the table.
 * `DataTable` writes `data-stacked`. The heads stay for a screen reader; the head of a group is the
 * words above its cards, and its row is no box.
 */
const TABLE_STACKED = [
  '[&[data-stacked=true]_:is(table,tbody,tr,td)]:block [&[data-stacked=true]_:is(table,tbody,tr,td)]:min-w-0',
  '[&[data-stacked=true]_:is(thead,th)]:absolute [&[data-stacked=true]_:is(thead,th)]:p-0 [&[data-stacked=true]_:is(thead,th)]:w-px [&[data-stacked=true]_:is(thead,th)]:h-px [&[data-stacked=true]_:is(thead,th)]:overflow-hidden [&[data-stacked=true]_:is(thead,th)]:[clip-path:inset(50%)] [&[data-stacked=true]_:is(thead,th)]:whitespace-nowrap',
  '[&[data-stacked=true]_tr]:flex [&[data-stacked=true]_tr]:flex-col [&[data-stacked=true]_tr]:gap-[8px] [&[data-stacked=true]_tr]:px-[20px] [&[data-stacked=true]_tr]:py-[14px] [&[data-stacked=true]_tr]:[border-bottom:1px_solid_var(--color-line)]',
  '[&[data-stacked=true]_td]:max-w-none [&[data-stacked=true]_td]:p-0 [&[data-stacked=true]_td]:[border-bottom:0]',
  '[&[data-stacked=true]_:is(th,td):is(:first-child,:last-child)]:max-w-none [&[data-stacked=true]_:is(th,td):is(:first-child,:last-child)]:p-0 [&[data-stacked=true]_:is(th,td):is(:first-child,:last-child)]:[border-bottom:0]',
  '[&[data-stacked=true]_td[data-align=end]]:text-left',
  '[&[data-stacked=true]_.kit-table-group]:contents',
  '[&[data-stacked=true]_tr.kit-table-group_th]:block [&[data-stacked=true]_tr.kit-table-group_th]:w-auto [&[data-stacked=true]_tr.kit-table-group_th]:h-auto [&[data-stacked=true]_tr.kit-table-group_th]:p-[8px_20px] [&[data-stacked=true]_tr.kit-table-group_th]:[border-bottom:1px_solid_var(--color-line)] [&[data-stacked=true]_tr.kit-table-group_th]:overflow-visible [&[data-stacked=true]_tr.kit-table-group_th]:[clip-path:none]',
].join(' ');

/**
 * Pinned heads (FRU-586): the head of the columns stays under what the screen pins at the top of the
 * window (`--kit-pinned-top`), and the head of a group under it while the group is on screen. The
 * frame clips and does not scroll: a frame that scrolls would hold its heads, not the window. The
 * borders are the cells' own (`separate`): a collapsed border stays in the table when its cell moves.
 * What takes focus is scrolled to under the pinned heads, never behind them (WCAG 2.4.11).
 */
const TABLE_PINNED = [
  '[&:not([data-stacked=true])_thead_th]:sticky [&:not([data-stacked=true])_thead_th]:top-[var(--kit-pinned-top,0px)] [&:not([data-stacked=true])_thead_th]:z-2 [&:not([data-stacked=true])_thead_th]:bg-page',
  '[&_tr.kit-table-group_th]:sticky [&_tr.kit-table-group_th]:top-[calc(var(--kit-pinned-top,0px)+var(--kit-table-head,0px))] [&_tr.kit-table-group_th]:z-1',
  '[&_:is(a,button,input,select,textarea,[tabindex])]:scroll-mt-[calc(var(--kit-pinned-top,0px)+var(--kit-table-head,0px)+48px)]',
].join(' ');

/**
 * A table in its frame. A table wider than the screen scrolls in the frame, and the page does not.
 * The frame takes focus, so a keyboard can scroll it (WCAG 2.1.1). It holds what is positioned in
 * it: the label of a field that only a screen reader reads is absolute, and out of a frame with no
 * position it widened the page past the screen (FRU-505).
 */
export function DataTable({
  label,
  minWidth,
  dense = false,
  hover = false,
  stack = false,
  pinned = false,
  children,
}: DataTableProps) {
  const frame = useRef<HTMLDivElement>(null);
  // A stacked table is a table only where its frame holds `minWidth` (FRU-586). The frame is measured,
  // not the window: the rail and the padding of the screen take a width that a media query does not
  // know. The attributes are written before the paint, so no frame shows a table cut by its edge.
  useLayoutEffect(() => {
    const element = frame.current;
    if (!stack || element === null) return;
    const measure = () => {
      const stacked = element.clientWidth < minWidth;
      element.dataset.stacked = String(stacked);
      // The heads of the groups stay under the head of the columns, which a card does not show.
      const head = stacked ? 0 : (element.querySelector('thead')?.getBoundingClientRect().height ?? 0);
      element.style.setProperty('--kit-table-head', `${head}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    // The head of the columns too: one that grew, with the frame as it was, moves the heads of the
    // groups under it (raised in review, FRU-586).
    const head = element.querySelector('thead');
    if (head !== null) observer.observe(head);

    return () => observer.disconnect();
  }, [stack, minWidth]);

  return (
    <div
      ref={frame}
      role="region"
      aria-label={label}
      tabIndex={0}
      className={[
        'kit-table relative border border-line rounded-frame [scrollbar-width:thin] [scrollbar-color:var(--field-border)_transparent]',
        stack && pinned ? `overflow-clip ${TABLE_PINNED}` : 'overflow-x-auto',
        TABLE_CELLS,
        dense ? '[&_td]:py-[12px]' : '[&_td]:py-[14px]',
        // The head of a group opens nothing: its tint stays under the pointer.
        hover ? '[&_tbody_tr:hover:not([data-chosen=true],.kit-table-group)]:bg-subtle' : '',
        TABLE_STACKED,
        stack && pinned ? '' : '[&[data-stacked=true]_tr.kit-table-group_th]:static',
      ].join(' ')}
      data-dense={dense}
      data-hover={hover}
      data-stack={stack}
      data-pinned={stack && pinned}
    >
      <table
        className={`w-full text-table ${stack && pinned ? 'border-separate border-spacing-0' : 'border-collapse'}`}
        style={stack ? undefined : { minWidth }}
      >
        {children}
      </table>
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

/**
 * A dialog over the page (FRU-558): its title names it, focus stays inside while it is open, and
 * Escape or the close button close it. Focus goes back to what opened it. HeroUI's Modal, on the
 * dialog of React Aria, does the trap, the labelling and the return.
 *
 * A press outside does not close it: a selection of text released past its edge would hide a form
 * and the sentence of its refusal (raised in review).
 *
 * `locked` takes away Escape and the close button while a form inside must end by its own buttons
 * (FRU-562): a secret shown once, or a key being typed, would go with the dialog.
 */
export function Dialog({
  open,
  onClose,
  title,
  closeLabel,
  size = 'lg',
  locked = false,
  className = '',
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** The name of the close button, e.g. « Close ». */
  closeLabel: string;
  size?: 'sm' | 'md' | 'lg';
  /** No Escape and no close button: the content closes it by its own buttons. */
  locked?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Modal.Backdrop
      isOpen={open}
      isDismissable={false}
      isKeyboardDismissDisabled={locked}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Modal.Container size={size} scroll="inside">
        <Modal.Dialog className={`kit-dialog ${className}`}>
          {locked ? null : <Modal.CloseTrigger aria-label={closeLabel} />}
          <Modal.Header>
            <Modal.Heading className="kit-dialog__title">{title}</Modal.Heading>
          </Modal.Header>
          <Modal.Body>{children}</Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

/**
 * A panel over the screen, at its right edge (FRU-653), as the drawer of HeroUI: named by its title,
 * focus kept inside, Escape and its close button close it, and focus goes back to what opened it. A
 * press outside closes it too: the list under it is where the person goes back to. At 390 px it takes
 * the whole width.
 */
export function Drawer({
  open,
  onClose,
  title,
  closeLabel,
  head,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  closeLabel: string;
  /** What stands above the title: the reference of the task, its buttons. */
  head?: ReactNode;
  children: ReactNode;
}) {
  return (
    <HeroDrawer.Backdrop
      isOpen={open}
      isDismissable
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <HeroDrawer.Content placement="right" className="kit-drawer">
        {/* HeroUI draws a drawer of 320 px, 85 % of the screen at most: the dialog is what takes its width. */}
        <HeroDrawer.Dialog className="kit-drawer__dialog w-[min(560px,100vw)] max-w-[100vw] h-full">
          <HeroDrawer.CloseTrigger aria-label={closeLabel} />
          <HeroDrawer.Header>
            {head}
            <HeroDrawer.Heading className="kit-drawer__title text-(length:--text-conclusion) font-semibold leading-[1.3]">
              {title}
            </HeroDrawer.Heading>
          </HeroDrawer.Header>
          <HeroDrawer.Body className="kit-drawer__body flex flex-col gap-[24px] overflow-y-auto">
            {children}
          </HeroDrawer.Body>
        </HeroDrawer.Dialog>
      </HeroDrawer.Content>
    </HeroDrawer.Backdrop>
  );
}

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
      className={`kit-panel min-w-0 max-w-full ${flush ? 'border-0 border-none border-current rounded-none bg-transparent' : 'border border-line rounded-frame bg-subtle'} ${className}`}
      data-spacing={spacing}
      {...(flush ? { 'data-flush': '' } : {})}
    >
      <div
        className={`kit-panel__head ${flush ? 'pt-[16px] px-[22px] pb-0 [border-bottom:0]' : 'py-[20px] px-[22px] [border-bottom:1px_solid_var(--color-line)]'}`}
      >
        <h2
          id={id}
          className={`kit-panel__title text-section font-bold ${flush ? 'absolute w-px h-px overflow-hidden [clip-path:inset(50%)] whitespace-nowrap' : ''}`}
        >
          {title}
        </h2>
        {detail === undefined ? null : (
          <p
            className={`kit-panel__detail ${flush ? 'mt-0' : 'mt-[2px]'} text-muted text-(length:--text-hint) leading-auto`}
          >
            {detail}
          </p>
        )}
      </div>
      <div
        className={`kit-panel__body flex flex-col ${spacing === 'tight' ? 'gap-[22px]' : 'gap-[24px]'} py-[20px] px-[22px]`}
      >
        {children}
      </div>
      {foot === undefined ? null : (
        <div className="kit-panel__foot flex flex-wrap items-center justify-between gap-x-[16px] gap-y-[8px] py-[14px] px-[22px] [border-top:1px_solid_var(--color-line)] text-(length:--text-hint)">
          {foot}
        </div>
      )}
    </aside>
  );
}

/**
 * The word a person compares with the one of another screen (FRU-240): white on ink, in a monospace
 * of 22 px, with what to do beside it. The word is text a screen reader reads, in its own element.
 */
export function VerifyWord({ word, children }: { word: string; children: ReactNode }) {
  return (
    <div className="kit-verify flex flex-wrap items-center justify-between gap-[16px] py-[18px] px-[20px] rounded-box bg-ink text-page">
      <span className="kit-verify__ask max-w-[220px] text-rail-text text-(length:--text-small) leading-[1.45]">
        {children}
      </span>
      <span className="kit-verify__word font-mono text-[22px] font-bold tracking-[0.08em]">{word}</span>
    </div>
  );
}

/** A list of a name and its value: « Signed in as », « Role », « Site ». */
export function KeyValue({ rows }: { rows: readonly { term: string; value: ReactNode }[] }) {
  return (
    <dl className="kit-key-value [border-top:1px_solid_var(--color-line)] text-(length:--text-body) leading-auto">
      {rows.map((row) => (
        <div
          key={row.term}
          className="flex justify-between gap-[16px] py-[12px] [border-bottom:1px_solid_var(--color-line)]"
        >
          <dt className="text-muted">{row.term}</dt>
          <dd className="min-w-0 m-0 font-semibold text-right [overflow-wrap:anywhere]">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The green drop with a check: something is done. A picture: the title under it says what.
 *
 * `inline` is the drop alone, at the size of a line of text, before the words that say what is done
 * (« Extension connected »). It is the drop of the stage « done », so the two read as one colour.
 */
export function SuccessMark({ size = 'page' }: { size?: 'page' | 'inline' }) {
  if (size === 'inline') return <StatusDot status="done" size={10} />;

  return (
    <span
      aria-hidden="true"
      className="kit-drop kit-success flex flex-none items-center justify-center size-[40px] rounded-[50%_50%_50%_0] [transform:rotate(-90deg)] bg-done [box-shadow:var(--shadow-pin)]"
    >
      <svg viewBox="0 0 24 24" className="size-[18px] [transform:rotate(90deg)]">
        <path
          d="M5 12.5l4.5 4.5L19 7.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-on-ink"
        />
      </svg>
    </span>
  );
}

/** The title of a page: its one `h1`. « setup » is the larger one of the setup. */
export function Title({ size = 'page', children }: { size?: 'page' | 'setup'; children: ReactNode }) {
  return (
    <h1
      className={`kit-title ${size === 'setup' ? 'text-title-setup text-balance' : 'text-title'} font-bold tracking-title`}
      data-size={size}
    >
      {children}
    </h1>
  );
}

/** The sentence under a title. */
export function Lead({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`kit-lead text-lead text-muted ${className}`}>{children}</p>;
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
    <header
      className={`kit-page-head flex flex-wrap items-end justify-between gap-x-[24px] gap-y-[16px] [&_.kit-title]:mb-[6px] ${className}`}
    >
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
    <nav aria-label={label} className="kit-subnav -mt-[12px] mx-0 mb-[28px] overflow-x-auto [scrollbar-width:none]">
      <ul className="flex gap-[24px] min-w-max [border-bottom:1px_solid_var(--color-line)]">
        {entries.map((entry) => (
          <li key={entry.to}>
            {/* 44 px high, the target of a finger. The focus ring is inside: the row scrolls in its frame. */}
            <Link
              to={entry.to}
              {...(entry.current ? { 'aria-current': 'page' as const } : {})}
              className={`inline-flex items-center h-control -mb-px text-(length:--text-small) font-semibold [text-decoration:none] focus-visible:outline-offset-[-2px]! ${entry.current ? '[border-bottom:2px_solid_var(--color-ink)] text-ink' : '[border-bottom:2px_solid_transparent] text-muted [&:hover]:text-ink'}`}
            >
              {entry.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The setup: two columns that wrap, laid out by the screen. */
const ENTRY_FULL =
  'flex-wrap items-start justify-start gap-[56px] box-border w-full max-w-[1280px] my-0 mx-auto pt-[48px] px-[clamp(16px,4vw,32px)] pb-[72px]';

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
    <div className="kit-entry flex flex-col min-h-screen">
      <header className="kit-entry__header [border-bottom:1px_solid_var(--color-line)]">
        {/* As the mockup writes it: the padding is outside the 1280 px, so the logo is at 80 px at 1440. */}
        <div className="flex flex-wrap items-center justify-between gap-x-[24px] gap-y-[8px] box-content max-w-[1280px] min-h-[64px] my-0 mx-auto py-0 px-[clamp(16px,4vw,32px)] text-muted text-(length:--text-small) leading-auto">
          <a href={SITE} className="kit-entry__logo flex py-[8px]">
            <Logo />
          </a>
          {aside ?? null}
        </div>
      </header>
      <main
        className={`kit-entry__main flex flex-auto ${width === 'full' ? ENTRY_FULL : 'justify-center pt-[clamp(48px,10vh,112px)] px-[16px] pb-[64px]'}`}
        data-width={width}
      >
        {width === 'full' ? (
          children
        ) : (
          <div
            className={`kit-entry__column flex flex-col w-full ${width === 'wide' ? 'max-w-[440px]' : 'max-w-[400px]'}`}
          >
            {children}
          </div>
        )}
      </main>
    </div>
  );
}

/** A rule with a word in its middle: « or », between two ways to do one thing. A picture only. */
export function Divider({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`kit-divider flex items-center gap-[12px] text-muted text-(length:--text-hint) leading-auto before:flex-1 before:h-px before:bg-line before:content-[''] after:flex-1 after:h-px after:bg-line after:content-[''] ${className}`}
    >
      {children}
    </div>
  );
}

/*
 * A menu. Its button is drawn by the screen or as a button that is a picture; it moves nothing under
 * a press. The menu is the surface of a page with the frame of a card, wherever its button is: on the
 * rail too.
 */
const MENU_TRIGGER = 'kit-menu-trigger cursor-pointer transform-none [transition:none]';
const MENU =
  'kit-menu min-w-[220px] border border-line rounded-box bg-surface text-ink [box-shadow:var(--shadow-frame)]';
/**
 * An item: tinted under the pointer and under the keyboard, and the ring of a page inside it, so the
 * menu does not clip it. The strong accent of an item that takes something away is 5.89:1 on the
 * tint, where the accent is 4.28:1.
 */
function itemClasses(danger: boolean): string {
  return `min-h-control-panel rounded-button text-(length:--text-small) leading-(--text-small--line-height) transform-none [transition:none] data-[hovered=true]:bg-chip data-[focused=true]:bg-chip data-[focus-visible=true]:[outline:2px_solid_var(--color-accent)] data-[focus-visible=true]:outline-offset-[-2px]! data-[focus-visible=true]:[box-shadow:none] ${danger ? 'text-accent-strong' : ''}`;
}
const MENU_WORDS = 'kit-menu__words flex min-w-0 flex-col';
const MENU_LABEL = 'text-inherit font-semibold';
const MENU_DETAIL = 'text-(length:--text-hint) leading-(--text-hint--line-height) text-muted';

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
        className={`${MENU_TRIGGER} ${trigger === 'icon' ? `${ICON_BUTTON} ${ICON_BUTTON_SIZE.chip}` : ''} ${triggerClassName}`}
        {...(triggerLabel === undefined ? {} : { 'aria-label': triggerLabel })}
      >
        {children}
      </Dropdown.Trigger>
      <Dropdown.Popover className={MENU} placement={trigger === 'icon' ? 'bottom end' : 'bottom start'}>
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
              {/* The items under a choice, which choose nothing (FRU-414): a rule of the menu above them. */}
              <Dropdown.Section className="kit-menu__after mt-[4px] pt-[4px] border-t border-line">
                {after.map((item) => menuItem(item, false))}
              </Dropdown.Section>
            </>
          )}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/**
 * An item of a submenu of `MenuTree`: `swatch` draws a colour before it. `closes`: choosing it closes a
 * `BranchMenu`, as an item that opens a dialog must (FRU-656).
 */
export type TreeItem = MenuItem & { swatch?: string; closes?: boolean };

/** A submenu of `MenuTree`: its items, and the ones checked when it is a choice. */
export type TreeBranch = {
  id: string;
  label: string;
  /** `single`: one item is checked; `multiple`: each item is checked or not; absent: a list of actions. */
  choice?: 'single' | 'multiple';
  checked?: readonly string[];
  items: readonly TreeItem[];
  onAction: (id: string) => void;
};

/**
 * A menu with submenus (FRU-654), as the dropdown of HeroUI: its button is a picture named by
 * `triggerLabel`, and `open` lets the screen open it on a right click. The arrows walk the items, the
 * right arrow opens a submenu, Escape closes it. The branches come first, then the plain `items`.
 */
export function MenuTree({
  branches,
  items,
  onAction,
  triggerLabel,
  open,
  onOpenChange,
  children,
}: {
  branches: readonly TreeBranch[];
  items: readonly MenuItem[];
  onAction: (id: string) => void;
  triggerLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Dropdown isOpen={open} onOpenChange={onOpenChange}>
      <Dropdown.Trigger className={`${MENU_TRIGGER} ${ICON_BUTTON} ${ICON_BUTTON_SIZE.chip}`} aria-label={triggerLabel}>
        {children}
      </Dropdown.Trigger>
      <Dropdown.Popover className={MENU} placement="bottom end">
        <Dropdown.Menu onAction={(id) => onAction(String(id))}>
          {[
            ...branches.map((branch) => (
              <Dropdown.SubmenuTrigger key={branch.id}>
                <Dropdown.Item id={branch.id} textValue={branch.label} className={itemClasses(false)}>
                  <span className={MENU_WORDS}>
                    <Label className={MENU_LABEL}>{branch.label}</Label>
                  </span>
                  <Dropdown.SubmenuIndicator />
                </Dropdown.Item>
                <Dropdown.Popover className={MENU}>{branchMenu(branch)}</Dropdown.Popover>
              </Dropdown.SubmenuTrigger>
            )),
            ...items.map((item) => menuItem(item, false)),
          ]}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** The items of one branch, as a menu of its own: a submenu of `MenuTree`, or the menu of `BranchMenu`. */
function branchMenu(branch: TreeBranch, onAction: (id: string) => void = branch.onAction) {
  return (
    <Dropdown.Menu
      aria-label={branch.label}
      onAction={(id) => onAction(String(id))}
      disabledKeys={branch.items.filter((item) => item.disabled === true).map((item) => item.id)}
      {...(branch.choice === undefined
        ? {}
        : { selectionMode: branch.choice, selectedKeys: [...(branch.checked ?? [])] })}
    >
      {branch.items.map((item) => (
        <Dropdown.Item
          key={item.id}
          id={item.id}
          textValue={item.label}
          data-danger={item.danger === true}
          className={itemClasses(item.danger === true)}
        >
          {branch.choice === undefined ? null : <Dropdown.ItemIndicator />}
          <span className={MENU_WORDS}>
            <span className="inline-flex items-center gap-[8px]">
              {item.swatch === undefined ? null : <Swatch colour={item.swatch} small />}
              <Label className={MENU_LABEL}>{item.label}</Label>
            </span>
            {item.detail === undefined ? null : <Description className={MENU_DETAIL}>{item.detail}</Description>}
          </span>
        </Dropdown.Item>
      ))}
    </Dropdown.Menu>
  );
}

/**
 * One branch of `MenuTree` behind a button of its own (FRU-656): the bar of a selection offers the
 * submenus of the menu of a task as buttons. The button says the name of the branch, and opens its
 * menu above it.
 */
export function BranchMenu({ branch, disabled = false }: { branch: TreeBranch; disabled?: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <Dropdown isOpen={open} onOpenChange={setOpen}>
      <Dropdown.Trigger
        className={`${MENU_TRIGGER} ${buttonClasses('outline', 'small', false, 'gap-[4px]')} kit-branch-trigger`}
        data-size="small"
        isDisabled={disabled}
      >
        {branch.label}
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-[14px] w-[14px]">
          <path
            d="M6 9l6 6 6-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </Dropdown.Trigger>
      <Dropdown.Popover className={MENU} placement="top start">
        {branchMenu(branch, (id) => {
          if (branch.items.some((item) => item.id === id && item.closes === true)) setOpen(false);
          branch.onAction(id);
        })}
      </Dropdown.Popover>
    </Dropdown>
  );
}

/**
 * The box that selects a row or a card (FRU-656): the checkbox of HeroUI, named by `label`, its box of
 * 16 px in a frame of 28 px that takes the press too. `onToggle` says whether Shift was held (`range`),
 * for a press of the pointer and for the Space key. `mixed`: some of what it stands for is selected.
 */
export function SelectBox({
  label,
  checked,
  mixed = false,
  onToggle,
  className = '',
}: {
  label: string;
  checked: boolean;
  mixed?: boolean;
  onToggle: (checked: boolean, range: boolean) => void;
  className?: string;
}) {
  // The change of HeroUI carries no event: Shift is read from the press or the key that makes it.
  const shift = useRef(false);
  const box = checkboxClasses({ bare: true });
  const held = (event: { shiftKey: boolean }) => {
    shift.current = event.shiftKey;
  };

  return (
    <span
      className={`kit-select inline-flex flex-none items-center justify-center size-[28px] cursor-pointer ${className}`}
      onPointerDownCapture={held}
      onKeyDownCapture={held}
    >
      <HeroCheckbox
        aria-label={label}
        isSelected={checked}
        isIndeterminate={mixed}
        onChange={(next) => onToggle(next, shift.current)}
        className={box.root}
      >
        <HeroCheckbox.Content className={box.content}>
          <HeroCheckbox.Control className={box.control}>
            <HeroCheckbox.Indicator />
          </HeroCheckbox.Control>
        </HeroCheckbox.Content>
      </HeroCheckbox>
    </span>
  );
}

/** A menu or a group of it where one item is checked: the current one. */
function choice(chosen: string) {
  return { selectionMode: 'single' as const, selectedKeys: [chosen], disallowEmptySelection: true };
}

function menuItem(item: MenuItem, checkable: boolean) {
  return (
    <Dropdown.Item
      key={item.id}
      id={item.id}
      textValue={item.label}
      data-danger={item.danger === true}
      className={itemClasses(item.danger === true)}
    >
      {checkable ? <Dropdown.ItemIndicator /> : null}
      <span className={MENU_WORDS}>
        <Label className={MENU_LABEL}>{item.label}</Label>
        {item.detail === undefined ? null : <Description className={MENU_DETAIL}>{item.detail}</Description>}
      </span>
    </Dropdown.Item>
  );
}

/** Where a step is: the one to do now, one to come, one that is done. */
export type StepState = 'current' | 'pending' | 'done';

/** The steps of a path, in order: an `<ol>` of `Step`. */
export function Steps({ children }: { children: ReactNode }) {
  return <ol className="kit-steps p-0 list-none">{children}</ol>;
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

/** The drop of a step: ink with its number, hollow when it is to come, green with a check when done. */
const STEP_MARK = {
  current:
    'flex flex-none items-center justify-center box-border size-[26px] rounded-[50%_50%_50%_0] [transform:rotate(-90deg)] bg-ink text-surface text-(length:--text-tiny) font-bold leading-none',
  pending:
    'flex flex-none items-center justify-center box-border size-[26px] rounded-[50%_50%_50%_0] [transform:rotate(-90deg)] [border:1.5px_solid_var(--field-border)] bg-surface text-muted text-(length:--text-tiny) font-bold leading-none',
  done: 'flex flex-none items-center justify-center box-border size-[26px] rounded-[50%_50%_50%_0] [transform:rotate(-90deg)] bg-done text-surface text-(length:--text-tiny) font-bold leading-none',
} as const satisfies Record<StepState, string>;

/** One step: its drop, the line down to the next one, its title and what the step holds. */
export function Step({ state, number, title, currentPrefix, children }: StepProps) {
  return (
    <li
      className="kit-step group/step grid grid-cols-[32px_minmax(0,1fr)] gap-x-[16px]"
      data-state={state}
      {...(state === 'current' ? { 'aria-current': 'step' as const } : {})}
    >
      <div className="kit-step__rail flex flex-col items-center gap-[8px] pt-px">
        {/* The drop is turned by a quarter: what it holds is turned back. */}
        <span aria-hidden="true" className={`kit-drop kit-step__mark ${STEP_MARK[state]}`}>
          {state === 'done' ? (
            <svg viewBox="0 0 24 24" className="size-[13px] [transform:rotate(90deg)]">
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
            <span className="[transform:rotate(90deg)]">{number}</span>
          )}
        </span>
        <span
          aria-hidden="true"
          className="kit-step__line flex-auto w-[2px] min-h-[24px] rounded-[2px] bg-line group-last/step:hidden"
        />
      </div>
      <div className="kit-step__body min-w-0 pb-[32px] group-last/step:pb-0">
        <h2 className={`kit-step__title text-step font-semibold ${state === 'pending' ? 'text-muted' : ''}`}>
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
    <div
      {...(status ? { role: 'status' as const } : {})}
      className={`kit-callout flex flex-col gap-[10px] min-w-0 [overflow-wrap:anywhere] py-[18px] px-[20px] border border-line rounded-box bg-subtle ${className}`}
    >
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
    <details
      id={id}
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
      className="kit-disclosure [border-top:1px_solid_var(--color-line)] [border-bottom:1px_solid_var(--color-line)]"
    >
      {/* The whole line is the target, 44 px at the least. The chevron turns. */}
      <summary className="kit-disclosure__summary flex items-center gap-[10px] min-h-control py-[14px] cursor-pointer list-none list-outside [&::-webkit-details-marker]:hidden">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="kit-disclosure__chevron flex-none size-[20px] text-muted [transition:transform_var(--duration-fast)_var(--ease-settle)] [details[open]_&]:[transform:rotate(90deg)] [summary:hover_&]:text-ink motion-reduce:[transition:none]"
        >
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
      <div className="kit-disclosure__body flex flex-col gap-[40px] pt-[16px] px-0 pb-[32px]">{children}</div>
    </details>
  );
}

/**
 * One way among a few to do a thing, in its card: its name, then what the screen puts in it.
 *
 * `badge`: a word beside the name, such as the way the screen recommends (FRU-610). `fold`: the card
 * opens folded to its name, with « Show » beside it. The button says whether it is expanded, and
 * names the part it opens. The part stays mounted while folded, hidden.
 */
export function OptionCard({
  title,
  badge,
  fold,
  children,
}: {
  title: string;
  badge?: string;
  fold?: { open: boolean; onToggle: (open: boolean) => void; show: string; hide: string };
  children: ReactNode;
}) {
  const body = useId();

  return (
    <div
      className="kit-option flex flex-col gap-[8px] min-w-0 p-[18px] border border-line rounded-box"
      data-folded={fold !== undefined && !fold.open ? '' : undefined}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <h3 className="kit-option__title text-(length:--text-body) font-semibold leading-auto">{title}</h3>
        {badge === undefined ? null : <Chip tone="accent">{badge}</Chip>}
        {fold === undefined ? null : (
          <HeroButton
            type="button"
            variant="ghost"
            className={`${LINK} ${LINK_SPACE.flush}`}
            data-space="flush"
            aria-expanded={fold.open}
            aria-controls={body}
            onPress={() => fold.onToggle(!fold.open)}
          >
            {fold.open ? fold.hide : fold.show}
          </HeroButton>
        )}
      </div>
      {/* Folded, the content stays mounted and is hidden: what it holds (a « Copied ») is kept. */}
      <div
        id={body}
        hidden={fold !== undefined && !fold.open}
        className={fold === undefined || fold.open ? 'contents' : ''}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Cards or buttons side by side while each has `min` pixels, then one under the other: no width of
 * a screen is named.
 */
export function AutoGrid({ min = 180, children }: { min?: 180 | 230; children: ReactNode }) {
  return (
    <div
      className={`kit-auto-grid grid ${min === 230 ? 'grid-cols-[repeat(auto-fit,minmax(min(230px,100%),1fr))] gap-[12px]' : 'grid-cols-[repeat(auto-fit,minmax(min(180px,100%),1fr))] gap-[10px]'}`}
      data-min={min}
    >
      {children}
    </div>
  );
}

/** Code to copy, as it is typed. Its box takes focus, so a keyboard scrolls a long line. */
export function Snippet({ label, className = '', children }: { label: string; className?: string; children: string }) {
  return (
    <pre
      role="region"
      aria-label={label}
      tabIndex={0}
      className={`kit-snippet overflow-x-auto whitespace-pre-wrap break-all py-[10px] px-[12px] border border-line rounded-button bg-subtle text-ink font-mono text-(length:--text-tiny) leading-[1.55] ${className}`}
    >
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
  /** The page, 620 px high, or 280 px (`short`). */
  children?: ReactNode;
  short?: boolean;
};

const BROWSER_DOTS = 'kit-browser__dots flex flex-none gap-[6px] w-[42px]';
const BROWSER_DOT = 'size-[10px] rounded-[50%] bg-line';

/** The window of a browser, drawn around the preview of a site. */
export function BrowserFrame({ address, empty, caption, children, short = false }: BrowserFrameProps) {
  return (
    <>
      <div className="kit-browser overflow-hidden border border-line rounded-frame bg-surface [box-shadow:var(--shadow-frame)]">
        {/* 44 px over its rule, as the mockup writes it. */}
        <div className="kit-browser__bar flex items-center gap-[12px] box-content h-[44px] py-0 px-[16px] [border-bottom:1px_solid_var(--color-line)] bg-subtle">
          <span aria-hidden="true" className={BROWSER_DOTS}>
            <span className={BROWSER_DOT} />
            <span className={BROWSER_DOT} />
            <span className={BROWSER_DOT} />
          </span>
          <span className="kit-browser__address flex flex-1 justify-center min-w-0">
            <span className="overflow-hidden py-[4px] px-[16px] border border-line rounded-[999px] bg-surface text-muted text-(length:--text-hint) leading-auto text-ellipsis whitespace-nowrap">
              {address}
            </span>
          </span>
          <span aria-hidden="true" className={BROWSER_DOTS} />
        </div>
        {/* On a phone the frame comes under the steps: with no site yet, a short frame says enough. */}
        <div
          className={`kit-browser__page relative overflow-hidden ${short ? 'h-[280px]' : `h-[620px] ${empty === undefined ? '' : 'max-sm:h-[280px]'}`}`}
        >
          {empty === undefined ? (
            children
          ) : (
            <div className="kit-browser__empty flex flex-col items-center justify-center gap-[18px] box-border h-full p-[24px] bg-subtle text-muted text-body text-center">
              <svg aria-hidden="true" viewBox="16 6 96 116" className="w-[56px] h-[68px] fill-line">
                <path
                  d="M 64 121.9 L 30.1 87.9 A 48 48 0 1 1 97.9 87.9 Z M 64 37 A 17 17 0 1 0 64 71 A 17 17 0 1 0 64 37 Z"
                  fillRule="evenodd"
                />
              </svg>
              {/* No sentence: the drop alone, for a page that has nothing to say yet. */}
              <p className="max-w-[280px] empty:hidden">{empty}</p>
            </div>
          )}
        </div>
      </div>
      {caption === undefined ? null : (
        <p className="kit-browser__caption mt-[12px] mx-[4px] mb-0 text-muted text-hint">{caption}</p>
      )}
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
function firstOf(groups: readonly OptionGroup[], limit: number): { groups: OptionGroup[]; left: number } {
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
  /**
   * What is typed, each time it changes (FRU-501): a list whose options are not all read yet asks
   * the server for those that hold it, and gives them in `groups`.
   */
  onSearch?: (search: string) => void;
  /**
   * Options offered after all the others, never searched and never paged (FRU-501): a read of more
   * options from the server, which a « Show more » of this list would otherwise hide.
   */
  tail?: readonly Option[];
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
  onSearch,
  tail = [],
}: SearchChoiceProps) {
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(page);
  const field = useRef<HTMLInputElement>(null);
  const found = searched(groups, search);
  const shown = firstOf(found, limit);
  const type = (value: string) => {
    setSearch(value);
    setLimit(page);
    onSearch?.(value);
  };
  const nothing = found.length === 0 && tail.length === 0;
  const empty = { value: placeholder, label: nothing ? noMatch : placeholder };

  return (
    <div className="kit-search-choice flex flex-col gap-[8px]">
      {/* The cross is in the field, at its right, while something is typed. */}
      <div className="kit-search-choice__search relative [&_.kit-icon-button]:absolute [&_.kit-icon-button]:top-[4px] [&_.kit-icon-button]:right-[4px]">
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
        disabled={disabled || nothing}
        onChange={(value) => {
          if (value === MORE) setLimit((current) => current + page);
          else if (value !== empty.value) onChoose(value);
        }}
        options={[
          empty,
          ...shown.groups,
          ...(shown.left === 0 ? [] : [{ value: MORE, label: moreLabel(Math.min(page, shown.left), shown.left) }]),
          ...tail,
        ]}
      />
    </div>
  );
}
