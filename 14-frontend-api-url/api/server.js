const http = require('node:http');

const todos = [
  { id: 1, title: 'Ship the release', done: false },
  { id: 2, title: 'Write the changelog', done: true },
];

http
  .createServer((req, res) => {
    if (req.url === '/todos') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(todos));
    }
    res.writeHead(404).end();
  })
  .listen(3000, () => console.log('api listening on :3000'));
