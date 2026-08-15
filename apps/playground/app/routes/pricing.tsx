import { CheckoutForm, LongSpacer, NewThisReleaseCard, type Plan, PlanCard, SiteHeader } from '../components/site';
import { useSiteState } from '../site-state';

export function meta() {
  return [{ title: 'Pricing — Acme' }];
}

const PLANS: Plan[] = [
  { id: 'espresso', name: 'Espresso', price: '9 €' },
  { id: 'latte', name: 'Latte', price: '19 €' },
  { id: 'mocha', name: 'Mocha', price: '29 €' },
];

export default function Pricing() {
  const { deployment, inserted, removed } = useSiteState();
  const plans = PLANS.filter((plan) => !removed.includes(plan.id));

  return (
    <main className="mx-auto max-w-5xl px-12 py-0">
      <SiteHeader />
      <h2 className="mb-8 mt-12 text-2xl font-semibold">Nos formules</h2>

      {/*
        Keyed on the deployment, so a "release" genuinely unmounts and remounts every card rather
        than mutating the nodes in place. That is the difference between this playground and the
        static one it replaced: re-anchoring now faces what React actually does.
      */}
      <ul className="cards mb-16 grid list-none grid-cols-3 gap-6 p-0" key={deployment}>
        {inserted ? (
          <li>
            <NewThisReleaseCard />
          </li>
        ) : null}
        {plans.map((plan) => (
          <li key={plan.id}>
            <PlanCard plan={plan} />
          </li>
        ))}
      </ul>

      <LongSpacer />
      <CheckoutForm />
      <footer className="py-12 text-stone-500">© Acme</footer>
    </main>
  );
}
