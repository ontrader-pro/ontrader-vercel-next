import express from 'express';
import indexDataHandler from './api/index-data.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('✅ API OnTrader está corriendo.');
});

app.get('/api/index-data', indexDataHandler);

app.listen(PORT, () => {
  console.log(`✅ API OnTrader corriendo en http://localhost:${PORT}`);
});
