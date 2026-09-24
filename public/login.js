document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  const errorMsg = document.getElementById('errorMsg');
  const btn = document.querySelector('.login-btn');
  
  errorMsg.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Signing in...';
  
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    
    if (res.ok) {
      // Return to the module whose session expired, when the link says so.
      const next = new URLSearchParams(window.location.search).get('next') || '';
      window.location.href = /^\/(?![\/\\])/.test(next) ? next : '/';
    } else {
      const data = await res.json();
      errorMsg.textContent = data.error || 'Login failed';
      errorMsg.style.display = 'block';
    }
  } catch (err) {
    errorMsg.textContent = 'Network error occurred';
    errorMsg.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
});
