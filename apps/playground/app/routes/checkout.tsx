import { Button, Card } from '@heroui/react';
import { SiteHeader } from '../components/site';

export function meta() {
  return [{ title: 'Commander — Acme' }];
}

/**
 * The second page, and the question it asks: a pin belongs to a URL, so navigating here has to
 * change which seeds are on screen. The overlay re-reads on every navigation for exactly that
 * reason — on a client-rendered app nothing else tells it the page changed.
 */
export default function Checkout() {
  return (
    <main className="mx-auto max-w-5xl px-12 py-0">
      <SiteHeader />
      <h2 className="mb-8 mt-12 text-2xl font-semibold">Votre commande</h2>

      <Card className="max-w-md">
        <Card.Content className="flex flex-col gap-3">
          <p className="text-stone-600">Un Latte, à emporter.</p>
          <div className="text-3xl font-bold">19 €</div>
          <Button id="pay-cta" data-testid="pay-cta" variant="danger" type="button">
            Payer
          </Button>
        </Card.Content>
      </Card>

      <footer className="py-12 text-stone-500">© Acme</footer>
    </main>
  );
}
