// « Copy » on every code block of the guides (FRU-417). The page reads the same without it: the
// button is added here, so a browser with no script shows no button that does nothing.
document.querySelectorAll('.prose pre').forEach((pre) => {
  if (!navigator.clipboard) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy';
  button.textContent = 'Copy';
  button.addEventListener('click', () => {
    navigator.clipboard.writeText(pre.innerText.replace(/\n$/, '')).then(
      () => {
        button.textContent = 'Copied';
        setTimeout(() => {
          button.textContent = 'Copy';
        }, 1500);
      },
      // A refused clipboard leaves the text on screen to select by hand.
      () => {
        button.textContent = 'Select the text';
      },
    );
  });
  // The button sits in the corner of the block: kramdown wraps a fenced block in a positioned box,
  // and a bare <pre> gets one here.
  let box = pre.closest('.highlighter-rouge');
  if (!box) {
    box = document.createElement('div');
    box.className = 'code-box';
    pre.before(box);
    box.append(pre);
  }
  box.prepend(button);
});

// An address of a part that moved to a page of its own (FRU-427): the old page keeps an empty element
// with the old id, which names the new address. The browser has scrolled to it; this goes on there.
function followMoved() {
  let id = '';
  try {
    id = decodeURIComponent(location.hash.slice(1));
  } catch {
    // A fragment with a stray « % » names no moved part (raised in review).
    return;
  }
  const to = id && document.getElementById(id)?.dataset.movedTo;
  if (to) location.replace(to);
}
followMoved();
window.addEventListener('hashchange', followMoved);
