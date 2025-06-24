
// pages/_app.js
import '../styles/globals.css'
import { SpeedInsights } from '@vercel/speed-insights'

function MyApp({ Component, pageProps }) {
  return (
    <>
      {/* Recoge métricas y las envía a tu dashboard de Vercel */}
      <SpeedInsights />
      <Component {...pageProps} />
    </>
  )
}

export default MyApp
