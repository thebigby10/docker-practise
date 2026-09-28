const API_URL = import.meta.env.VITE_API_URL;
const list = document.querySelector('#todos');

async function render() {
  const res = await fetch(`${API_URL}/todos`);
  const todos = await res.json();
  const onlyDone = location.pathname === '/done';
  list.replaceChildren(
    ...todos
      .filter((t) => !onlyDone || t.done)
      .map((t) => Object.assign(document.createElement('li'), { textContent: t.title })),
  );
}

document.querySelectorAll('[data-link]').forEach((a) =>
  a.addEventListener('click', (e) => {
    e.preventDefault();
    history.pushState(null, '', a.getAttribute('href'));
    render();
  }),
);

render();
