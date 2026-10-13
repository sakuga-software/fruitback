import { useState } from 'react';
import {
  AutoGrid,
  BrowserFrame,
  Button,
  Callout,
  EntryPage,
  Chip,
  Choice,
  Divider,
  DataTable,
  Field,
  FilterChip,
  IconButton,
  Initial,
  KeyValue,
  Lead,
  Logo,
  OptionCard,
  LinkButton,
  Menu,
  PageHead,
  Pick,
  Problem,
  STATUSES,
  SidePanel,
  Snippet,
  StatusBar,
  StatusDot,
  Step,
  Steps,
  SuccessMark,
  Title,
  Toggle,
  WideButton,
} from './ui';

/**
 * Every component of the kit, mounted once (FRU-232). It is a page of the development server only:
 * `routes.ts` does not list it in a build. `e2e/console-kit.spec.ts` reads the computed styles here
 * and compares them to the mockup, so a screen never has to be in a given state for a measure.
 *
 * The words are samples and go through no translation: no person sees this page.
 */
export default function KitGallery() {
  const [on, setOn] = useState(true);
  const [off, setOff] = useState(false);
  const [filter, setFilter] = useState('all');
  const [who, setWho] = useState<'members' | 'public'>('members');
  const [role, setRole] = useState('guest');
  const [stage, setStage] = useState('progress');
  const [text, setText] = useState('');
  const [picked, setPicked] = useState('nothing');
  const [workspace, setWorkspace] = useState('acme');

  return (
    <main className="mx-auto flex max-w-[1120px] flex-col gap-10 px-8 py-10">
      <PageHead title="Kit" lead="Every component of the console, once." action={<Button>Add a site</Button>} />

      <section aria-label="Titles" className="flex flex-col gap-2" data-kit="titles">
        <Title size="setup">Set up Fruitback</Title>
        <Lead>Three steps to your first note on a live page.</Lead>
      </section>

      <section aria-label="Buttons" className="flex flex-wrap items-center gap-4" data-kit="buttons">
        <Button>Email me a link</Button>
        <Button disabled>Primary disabled</Button>
        <Button size="panel">Primary panel</Button>
        <Button tone="outline" size="page">
          Try again
        </Button>
        <Button tone="outline">Connect</Button>
        <Button tone="outline" size="small">
          Send again
        </Button>
        <Button tone="outline" disabled>
          Outline disabled
        </Button>
        <Button tone="outline" size="page" inset={16}>
          Send again in 0:41
        </Button>
        <Button tone="outline" size="page" href="https://fruitback.com">
          Continue in this tab
        </Button>
        <Button tone="quiet">Quiet</Button>
        <Button tone="danger">Danger</Button>
        <LinkButton>Use another address</LinkButton>
        <LinkButton space="loose">Loose link</LinkButton>
        <LinkButton disabled>Link disabled</LinkButton>
        <LinkButton href="https://fruitback.com">Help and docs</LinkButton>
        <IconButton label="More for staging.acme.dev" menu>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <circle cx="5" cy="12" r="1.8" fill="currentColor" />
            <circle cx="12" cy="12" r="1.8" fill="currentColor" />
            <circle cx="19" cy="12" r="1.8" fill="currentColor" />
          </svg>
        </IconButton>
        <p className="text-small text-muted">
          New to Fruitback?{' '}
          <LinkButton space="inline" to="/setup">
            Set up a workspace
          </LinkButton>
        </p>
      </section>

      <section aria-label="Wide buttons" className="flex w-[400px] max-w-full flex-col gap-2.5" data-kit="wide">
        <WideButton>Continue with Google</WideButton>
        <Button wide>Join a workspace with a very long name that somebody typed in a hurry one day</Button>
        <WideButton disabled note="GitHub sign-in is not set up on this Fruitback">
          Continue with GitHub
        </WideButton>
      </section>

      <section aria-label="Fields" className="flex w-[400px] max-w-full flex-col gap-3.5" data-kit="fields">
        <Field
          label="Work email"
          type="email"
          placeholder="you@studio.com"
          hint="Your workspace takes the name of your domain."
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <Field label="Search" compact placeholder="Search the notes" />
        <Field label="Instance address" locked value="https://feedback.acme.dev" />
        <Field label="Disabled field" disabled value="staging.acme.dev" />
        <Choice
          label="Role"
          value={role}
          onChange={setRole}
          options={[
            { value: 'guest', label: 'Guest, one site' },
            { value: 'member', label: 'Member' },
          ]}
        />
        <div className="w-[214px]" data-kit="status-choice">
          <Choice
            label="Status for In Review"
            labelHidden
            status={stage === 'todo' ? 'todo' : 'progress'}
            value={stage}
            onChange={setStage}
            options={[
              { value: 'todo', label: 'To do' },
              { value: 'progress', label: 'In progress' },
            ]}
          />
        </div>
        <Button tone="outline" label="Connect Jira">
          Connect
        </Button>
        <Choice
          label="Compact role"
          compact
          value={role}
          onChange={setRole}
          options={[
            { value: 'guest', label: 'Guest, one site' },
            { value: 'member', label: 'Member' },
          ]}
        />
        <Pick
          label="Who sees the notes?"
          value={who}
          onChange={setWho}
          options={[
            { value: 'members', label: 'Members of Acme', detail: 'Visitors of the site see nothing.' },
            { value: 'public', label: 'Everyone who visits', detail: 'A public way to report a problem.' },
          ]}
        />
      </section>

      <section aria-label="Toggles" className="flex w-[340px] max-w-full flex-col gap-3" data-kit="toggles">
        <Toggle label="Show Linear comments as replies" value={on} onChange={setOn} />
        <Toggle label="Attach a picture of the element" value={off} onChange={setOff} />
        <Toggle label="A setting that cannot change" value={false} onChange={() => {}} disabled />
      </section>

      <section aria-label="Statuses" className="flex flex-col gap-3" data-kit="statuses">
        <ul className="flex flex-wrap gap-x-[18px] gap-y-1.5 text-hint text-muted">
          {STATUSES.map((status) => (
            <li key={status} className="flex items-center gap-[7px]">
              <StatusDot status={status} />
              {status}
            </li>
          ))}
        </ul>
        <p className="flex items-center gap-2 text-small">
          <StatusDot status="new" size={10} />
          <StatusDot status="todo" size={11} />
          Sizes 10 and 11
        </p>
        <StatusBar
          counts={{ new: 3, todo: 2, progress: 4, done: 2, closed: 1 }}
          label="3 new, 2 to do, 4 in progress, 2 done, 1 closed"
        />
        <StatusBar
          width="short"
          counts={{ new: 1, todo: 0, progress: 0, done: 2, closed: 0 }}
          label="1 new, 0 to do, 0 in progress, 2 done, 0 closed"
        />
        <StatusBar
          width="full"
          counts={{ new: 3, todo: 2, progress: 4, done: 2, closed: 1 }}
          label="3 new, 2 to do, 4 in progress, 2 done, 1 closed"
        />
        <SuccessMark />
      </section>

      <div role="group" aria-label="Filters" className="flex flex-wrap gap-2" data-kit="chips">
        <FilterChip pressed={filter === 'all'} onChange={() => setFilter('all')} count={31}>
          All
        </FilterChip>
        <FilterChip pressed={filter === 'new'} onChange={() => setFilter('new')} count={7}>
          New
        </FilterChip>
        <FilterChip pressed={filter === 'failed'} onChange={() => setFilter('failed')} count={2} alert>
          Not delivered
        </FilterChip>
      </div>

      <section aria-label="Table" data-kit="table">
        <DataTable label="Members" minWidth={760} dense hover>
          <thead>
            <tr>
              <th scope="col">Person</th>
              <th scope="col">Role</th>
              <th scope="col" data-align="end">
                Last seen
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <span className="flex items-center gap-3">
                  <Initial name="Ana" />
                  <span>
                    <span className="block font-semibold">Ana</span>
                    <span className="block text-hint text-muted">ana@acme.dev</span>
                  </span>
                </span>
              </td>
              <td>Owner</td>
              <td data-align="end" className="text-muted">
                Now
              </td>
            </tr>
            <tr>
              <td>
                <span className="flex items-center gap-3">
                  <Initial name="tom@client.fr" pending />
                  <span className="font-semibold">tom@client.fr</span>
                </span>
              </td>
              <td>Guest</td>
              <td data-align="end" className="text-muted">
                <LinkButton>Resend</LinkButton>
              </td>
            </tr>
          </tbody>
        </DataTable>
      </section>

      <section aria-label="Panel" className="flex flex-wrap items-start gap-7" data-kit="panel">
        <SidePanel
          id="kit-panel-title"
          panelId="kit-panel"
          label="Settings of Linear"
          title="Linear"
          detail="Connected by Ana with OAuth"
          className="w-[380px]"
          foot={
            <>
              <LinkButton space="normal">Disconnect Linear</LinkButton>
              <span className="text-muted tabular-nums">Last issue created 12 min ago</span>
            </>
          }
        >
          <p className="text-small font-semibold text-accent-strong" data-kit="alert-on-subtle">
            2 notes did not arrive
          </p>
          <Toggle label="Attach a picture of the element" value={on} onChange={setOn} />
        </SidePanel>
        <div className="w-[440px] max-w-full">
          <KeyValue
            rows={[
              { term: 'Signed in as', value: 'ana@acme.dev' },
              { term: 'Role', value: 'Guest' },
              { term: 'Site', value: 'staging.acme.dev' },
            ]}
          />
        </div>
      </section>

      <section aria-label="Notices" className="flex w-[440px] max-w-full flex-col gap-3" data-kit="notices">
        <Problem>Fruitback did not answer. Try again.</Problem>
        <p className="text-small font-semibold text-accent" data-kit="alert-on-white">
          2 notes did not arrive
        </p>
        <p className="bg-chip p-2 text-small font-semibold text-accent-strong" data-kit="alert-on-chip">
          Suspended
        </p>
        <p className="flex gap-2">
          <Chip>Member</Chip>
          <Chip tone="accent">Owner</Chip>
          <Chip tone="done">Invited</Chip>
        </p>
        <Initial name="Marie" size="small" />
      </section>

      <section aria-label="Menus" className="flex flex-wrap items-center gap-6" data-kit="menus">
        <Menu
          trigger="icon"
          triggerLabel="More for staging.acme.dev"
          onAction={setPicked}
          items={[
            { id: 'install', label: 'Install' },
            { id: 'audience', label: 'Change who sees the notes' },
            { id: 'later', label: 'Not yet', disabled: true },
            { id: 'remove', label: 'Remove', danger: true },
          ]}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <circle cx="5" cy="12" r="1.8" fill="currentColor" />
            <circle cx="12" cy="12" r="1.8" fill="currentColor" />
            <circle cx="19" cy="12" r="1.8" fill="currentColor" />
          </svg>
        </Menu>
        <span className="kit-rail bg-rail p-3">
          <Menu
            chosen={workspace}
            onAction={setWorkspace}
            triggerClassName="flex items-center gap-2 rounded-box p-2 text-white"
            items={[
              { id: 'acme', label: 'Acme', detail: 'Owner' },
              { id: 'lumen', label: 'Lumen Studio', detail: 'Member' },
            ]}
          >
            Workspace
          </Menu>
        </span>
        <p className="text-small text-muted" data-kit="menu-picked">
          Picked: {picked}, {workspace}
        </p>
      </section>

      <section aria-label="Steps" className="w-[400px] max-w-full" data-kit="steps">
        <Steps>
          <Step state="done" number={1} title="Your account" currentPrefix="Current step:">
            <p className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-body text-muted">
              Workspace <span className="font-semibold text-ink">Acme</span>
              <LinkButton space="flush">Rename</LinkButton>
            </p>
          </Step>
          <Step state="current" number={2} title="Your site" currentPrefix="Current step:">
            <Callout status className="mt-3">
              <p className="text-body font-semibold leading-auto">Check your inbox</p>
            </Callout>
          </Step>
          <Step state="pending" number={3} title="Put it on the site" currentPrefix="Current step:">
            <p className="mt-0.5 text-small text-muted">The extension, or a script tag.</p>
          </Step>
        </Steps>
      </section>

      <section aria-label="Options" className="w-[520px] max-w-full" data-kit="options">
        <AutoGrid min={230}>
          <OptionCard title="Browser extension">
            <p className="text-small text-muted">Nothing to deploy.</p>
          </OptionCard>
          <OptionCard title="Script tag">
            <Snippet label="The script tag of staging.acme.dev">
              {'<script\n  src="https://cloud.fruitback.com/fruitback.iife.js"\n  defer></script>'}
            </Snippet>
          </OptionCard>
        </AutoGrid>
        <div className="mt-4">
          <AutoGrid>
            <WideButton>Continue with Google</WideButton>
            <WideButton>Continue with GitHub</WideButton>
          </AutoGrid>
        </div>
      </section>

      <section aria-label="Preview of your site" className="w-[760px] max-w-full" data-kit="browser">
        <BrowserFrame
          address="your site"
          empty="Your site shows here once you add it, with its pins."
          caption="A preview of your site. Pins show the same way on the real page."
        />
      </section>

      <section aria-label="Logos" className="flex flex-wrap items-center gap-6" data-kit="logos">
        <Logo />
        <span className="kit-rail bg-rail p-3">
          <Logo on="rail" />
        </span>
        <Divider className="w-[400px] max-w-full">or</Divider>
      </section>
    </main>
  );
}

/** The frame of a page outside a workspace, as the sign-in has it: a page of its own, for its `main`. */
export function KitEntryGallery() {
  return (
    <EntryPage aside={<span>Running your own server?</span>}>
      <div className="mb-2">
        <Title>Sign in to Fruitback</Title>
      </div>
      <Lead className="mb-7">We email you a link that signs you in on this browser.</Lead>
      <Divider className="my-[22px]">or</Divider>
    </EntryPage>
  );
}
