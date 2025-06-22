import { useEffect, useState } from 'react';

export default function Home() {
  const [data, setData] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [err, setErr] = useState('');

  async function refresh() {
    setErr('');
    try {
      const res = await fetch('/api/index-data');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || res.statusText);
      setData(json.data);
      setAlerts(json.alerts);
    } catch(e) {
      setErr(e.message);
    }
  }

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 120000);
    return () => clearInterval(iv);
  }, []);

  return (
    <div style={{ padding: 20, fontFamily: 'sans-serif', background: '#101729', color: '#fff' }}>
      <h1>OnTrader Panel (Futuros)</h1>
      {err && <div style={{ color: 'salmon' }}>{err}</div>}
      <h2>Alertas</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th>Hora</th><th>Sym</th><th>Old</th><th>New</th><th>Price</th><th>Score</th></tr></thead>
        <tbody>{alerts.map((a,i) =>
          <tr key={i}>
            <td>{a.time}</td><td>{a.symbol}</td><td>{a.oldPhase}</td><td>{a.newPhase}</td><td>{a.price}</td><td>{a.score}</td>
          </tr>
        )}</tbody>
      </table>
      <h2>Ranking Top 100</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th>Sym</th><th>Price</th><th>Prev</th><th>Score</th><th>Phase</th></tr></thead>
        <tbody>{data.map(d =>
          <tr key={d.symbol}>
            <td>{d.symbol}</td><td>{d.price}</td><td>{d.prevScore}</td><td style={{ color: d.score>=8?'limegreen':d.score>=5?'orange':'red' }}>{d.score}</td><td>{d.phase}</td>
          </tr>
        )}</tbody>
      </table>
    </div>
  );
}
