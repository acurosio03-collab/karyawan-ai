'use strict';
/* Boot: cek sesi -> dashboard atau login/setup. */
G.boot = async () => {
  try {
    const me = await G.api.get('/auth/me');
    G.state.user = me.user; G.state.csrf = me.csrf_token; G.state.workspace = me.workspace;
    G.showApp();
  } catch (e) {
    if (e.status === 401) return G.showLogin();
    document.getElementById('boot').hidden = true;
    const app = document.getElementById('app'); app.hidden = false;
    app.innerHTML = html`<div class="authwrap"><div class="card authcard"><h2>Tidak dapat memuat aplikasi</h2><p class="notice err">${G.errText(e)}</p><button class="btn pri" id="rl">Coba lagi</button></div></div>`.s;
    document.getElementById('rl').onclick = () => location.reload();
  }
};
G.boot();
