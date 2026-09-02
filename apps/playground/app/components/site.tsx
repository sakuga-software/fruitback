import { Button, Card, Input } from '@heroui/react';
import { useId } from 'react';
import { Link } from 'react-router';
import { hashedButtonClass, hashedMenuClass, useSiteState } from '../site-state';

/**
 * The fake client site, as named components.
 *
 * The names are the point. `getElementContext` reads the component and the source file off the React
 * fiber, and on the static playground there was no fiber to read — so the half of a seed that says
 * *which component* a note is about had never been exercised end to end. Every element the E2E suite
 * points at now belongs to a component with a name worth seeing in a Linear issue.
 */

export function SiteHeader() {
  // React's own generated id, which is exactly the kind the selector heuristics must refuse: stable
  // for one render, different after the next deploy remounts this subtree.
  const menuId = useId();
  const { build } = useSiteState();

  return (
    <header className="flex items-center justify-between border-b border-stone-200 px-12 py-6">
      <h1 className="text-3xl font-bold">Acme</h1>
      <nav className="flex items-center gap-4">
        <Link to="/" className="text-sm text-stone-600">
          Formules
        </Link>
        <Link to="/checkout" className="text-sm text-stone-600">
          Commander
        </Link>
        <button id={menuId} className={hashedMenuClass(build)} aria-label="Ouvrir le menu" type="button">
          ☰
        </button>
      </nav>
    </header>
  );
}

export type Plan = { id: string; name: string; price: string };

export function PlanCard({ plan }: { plan: Plan }) {
  const { build } = useSiteState();

  return (
    <Card className="card" data-testid={`card-${plan.id}`}>
      <Card.Content className="flex flex-col gap-2">
        <h3 className="text-lg font-semibold">{plan.name}</h3>
        <div className="text-3xl font-bold">{plan.price}</div>
        <AddToCartButton className={`add ${hashedButtonClass(build)}`} />
      </Card.Content>
    </Card>
  );
}

/** Three of these render at once, saying the same word — which is what makes text ambiguous. */
export function AddToCartButton({ className }: { className: string }) {
  return (
    <Button className={className} variant="danger" type="button">
      Ajouter
    </Button>
  );
}

export function NewThisReleaseCard() {
  return (
    <Card className="card" data-fruit-inserted="true">
      <Card.Content className="flex flex-col gap-2">
        <h3 className="text-lg font-semibold">Nouveau</h3>
        <div className="text-3xl font-bold">—</div>
      </Card.Content>
    </Card>
  );
}

/** Enough page to force a scroll, so a pin below the fold has somewhere to be. */
export function LongSpacer() {
  return (
    <div className="flex h-[700px] items-center justify-center text-stone-400">
      — beaucoup de contenu entre les deux —
    </div>
  );
}

export function CheckoutForm() {
  return (
    <form
      className="max-w-md rounded-xl border border-stone-200 bg-white p-6"
      onSubmit={(event) => event.preventDefault()}
    >
      <label htmlFor="email-field" className="mb-1 block text-sm text-stone-600">
        Votre e-mail
      </label>
      <Input id="email-field" name="email" placeholder="vous@exemple.fr" className="mb-4" />
      <Button id="checkout-cta" data-testid="checkout-cta" className="add" variant="danger" type="button">
        Commander
      </Button>
    </form>
  );
}
