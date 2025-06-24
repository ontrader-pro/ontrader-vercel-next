// pages/_app.js
import '../styles/globals.css';   // o la ruta donde tengas tus estilos globales

function MyApp({ Component, pageProps }) {
  return <Component {...pageProps} />;
}

export default MyApp;
// pages/_app.js
import '../styles/globals.css';
+ import { SpeedInsights } from '@vercel/speed-insights';

function MyApp({ Component, pageProps }) {
+   // Este componente recoge métricas y las envía a tu dashboard de Vercel
+   return (
+     <>
+       <SpeedInsights />
+       <Component {...pageProps} />
+     </>
+   );
}

export default MyApp;
