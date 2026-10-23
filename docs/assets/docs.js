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
