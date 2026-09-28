const list = document.querySelector('#notes');
const form = document.querySelector('form');

async function load() {
  const notes = await (await fetch('/api/notes')).json();
  list.replaceChildren(
    ...notes.map((n) => Object.assign(document.createElement('li'), { textContent: n.body })),
  );
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  await fetch('/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: form.body.value }),
  });
  form.reset();
  load();
});

load();
