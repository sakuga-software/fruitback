import { GALLERY, type Surface } from './states.ts';

/**
 * Draws the states of the surface of this page. `?state=<id>` draws that state alone, as the page of
 * the extension draws it: the captures of the artefact are taken that way.
 */
const surface = document.body.dataset.surface as Surface;
const states = GALLERY[surface]();
const asked = new URLSearchParams(location.search).get('state');
const app = document.querySelector('#app');
const alone = states.find((each) => each.id === asked);

if (alone !== undefined) {
  document.title = `${alone.title} · Fruitback gallery`;
  app?.replaceChildren(alone.build(document));
} else {
  document.body.classList.add('gallery-all');
  app?.replaceChildren(
    ...states.map((state) => {
      const section = document.createElement('section');
      section.className = 'gallery-state';
      section.id = state.id;
      section.dataset.state = state.id;
      const name = document.createElement('a');
      name.className = 'gallery-name';
      name.href = `?state=${state.id}`;
      name.textContent = state.title;
      const frame = document.createElement('div');
      frame.className = `gallery-frame gallery-frame-${surface}`;
      frame.append(state.build(document));
      section.append(name, frame);

      return section;
    }),
  );
}
