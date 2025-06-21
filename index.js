// pages/index.js
import { useEffect, useState } from 'react';

export default function Home(){
  const [data, setData] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  async function refresh(){
    setLoading(true);
    setErr('');
    try{
      const res = await fetch('/api/index-data');
      const json = await res.json();
      if(res.ok){
        setData(json.data);
        setAlerts(json.alerts);
      } else throw new Error(json.error||res.statusText);
    }catch(e){
      setErr(e.message);
    }
    setLoading(false);
  }

  useEffect(()=>{
    refresh();
    const iv = setInterval(refresh, 120000);
    return ()=> clearInterval(iv);
  },[]);

  return (
    <div style={{padding:20,fontFamily:'sans-serif',background:'#101729',color:'#fff'}}>
      <h1>OnTrader Index Panel (Futuros)</h1>
      {err && <div style={{color:'salmon'}}>{err}</div>}
      <div>
        <h2>Últimas Alertas</h2>
        <table style={{width:'100%',borderCollapse:'collapse'}}>
          <thead><tr>
            <th>Hora</th><th>Symbol</th><th>Old</th><th>New</th><th>Price</th><th>Score</th>
          </tr></thead>
          <tbody>
            {alerts.map((a,i)=>
              <tr key={i}>
                <td>{a.time}</td><td>{a.symbol}</td>
                <td>{a.oldPhase}</td><td>{a.newPhase}</td>
                <td>{a.price.toFixed(6)}</td><td>{a.score}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div>
        <h2>Ranking Top 100</h2>
        {loading ? <p>Cargando…</p> :
        <table style={{width:'100%',borderCollapse:'collapse'}}>
          <thead><tr>
            <th>Symbol</th><th>Price</th><th>Prev</th><th>Score</th><th>Phase</th>
          </tr></thead>
          <tbody>
            {data.map(d=>
              <tr key={d.symbol}>
                <td>{d.symbol}</td>
                <td>{d.price}</td>
                <td>{d.prevScore}</td>
                <td style={{color: d.score>=8?'limegreen':d.score>=5?'orange':'red'}}>
                  {d.score}
                </td>
                <td>{d.phase}</td>
              </tr>
            )}
          </tbody>
        </table>}
      </div>
    </div>
  );
}
