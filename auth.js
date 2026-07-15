// auth.js — login de gerentes, sessão e recuperação de senha por e-mail
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { carregar } = require('./db');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

function hashSenha(senha) {
  return bcrypt.hashSync(senha, 10);
}

function compararSenha(senha, hash) {
  return bcrypt.compareSync(senha, hash);
}

function gerarToken() {
  return crypto.randomBytes(24).toString('hex');
}

async function enviarEmailRecuperacao(destino, link) {
  await transporter.sendMail({
    from: `"Lista VIP" <${process.env.GMAIL_USER}>`,
    to: destino,
    subject: 'Recuperação de senha — Lista VIP',
    html: `
      <div style="font-family: Arial, sans-serif; background:#0a0a0c; color:#fff; padding:32px; border-radius:12px;">
        <h2 style="margin:0 0 12px;">Recuperação de senha</h2>
        <p style="color:#ccc;">Clique no botão abaixo para criar uma nova senha. Esse link expira em 30 minutos.</p>
        <a href="${link}" style="display:inline-block; margin-top:16px; padding:12px 24px; background:#e4e4ea; color:#0a0a0a; font-weight:bold; text-decoration:none; border-radius:8px;">Redefinir senha</a>
        <p style="color:#666; font-size:12px; margin-top:20px;">Se você não pediu essa recuperação, ignore este e-mail.</p>
      </div>
    `
  });
}

async function enviarEmailConfirmacaoLista(destino, dados) {
  const { nome_completo, numero, evento_nome, rp_nome } = dados;
  const numeroFmt = String(numero).padStart(3, '0');
  await transporter.sendMail({
    from: `"Lista VIP" <${process.env.GMAIL_USER}>`,
    to: destino,
    subject: `Seu número na lista: ${numeroFmt} — ${evento_nome}`,
    html: `
      <div style="font-family: Arial, sans-serif; background:#0a0a0c; color:#fff; padding:32px; border-radius:12px;">
        <h2 style="margin:0 0 12px;">Você está na lista!</h2>
        <p style="color:#ccc;">Oi ${nome_completo}, guarde este e-mail. Na entrada de <strong>${evento_nome}</strong>, fale o nome "${rp_nome}" e o número abaixo para o segurança confirmar sua vaga.</p>
        <div style="font-size:48px; font-weight:bold; letter-spacing:4px; text-align:center; margin:24px 0;">${numeroFmt}</div>
        <p style="color:#ccc; text-align:center;">RP: <strong>${rp_nome}</strong></p>
        <p style="color:#666; font-size:12px; margin-top:20px;">Se esquecer o número, você pode consultar de novo pelo whatsapp que usou na inscrição.</p>
      </div>
    `
  });
}

async function enviarEmailConfirmacaoListaMultipla(destino, dados) {
  const { pessoas, evento_nome, rp_nome } = dados;
  const linhas = pessoas.map(p => `
    <tr>
      <td style="padding:8px 0; color:#fff;">${p.nome_completo}</td>
      <td style="padding:8px 0; text-align:right; font-family:'JetBrains Mono', monospace; font-size:20px; font-weight:bold; color:#fff;">${String(p.numero).padStart(3, '0')}</td>
    </tr>
  `).join('');

  await transporter.sendMail({
    from: `"Lista VIP" <${process.env.GMAIL_USER}>`,
    to: destino,
    subject: `${pessoas.length} números na lista — ${evento_nome}`,
    html: `
      <div style="font-family: Arial, sans-serif; background:#0a0a0c; color:#fff; padding:32px; border-radius:12px;">
        <h2 style="margin:0 0 12px;">Vocês estão na lista!</h2>
        <p style="color:#ccc;">Guarde este e-mail. Na entrada de <strong>${evento_nome}</strong>, cada pessoa fala o nome "${rp_nome}" e o número correspondente abaixo para o segurança confirmar a vaga.</p>
        <table style="width:100%; border-collapse:collapse; margin:20px 0;">${linhas}</table>
        <p style="color:#ccc;">RP: <strong>${rp_nome}</strong></p>
        <p style="color:#666; font-size:12px; margin-top:20px;">Se esquecer algum número, dá pra consultar de novo pelo whatsapp que foi usado na inscrição.</p>
      </div>
    `
  });
}

function exigirLogin(req, res, next) {
  if (req.session && req.session.gerenteId) return next();
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ erro: 'Faça login para continuar' });
  }
  return res.redirect('/login.html');
}

// Só o administrador (primeira conta criada) pode mexer nos eventos
function exigirAdmin(req, res, next) {
  if (!req.session || !req.session.gerenteId) {
    if (req.originalUrl.startsWith('/api/')) {
      return res.status(401).json({ erro: 'Faça login para continuar' });
    }
    return res.redirect('/login.html');
  }

  const data = carregar();
  const gerente = data.gerentes.find(g => g.id === req.session.gerenteId);
  if (!gerente || gerente.role !== 'admin') {
    if (req.originalUrl.startsWith('/api/')) {
      return res.status(403).json({ erro: 'Só o administrador pode fazer isso' });
    }
    return res.redirect('/dashboard.html');
  }
  next();
}

module.exports = { hashSenha, compararSenha, gerarToken, enviarEmailRecuperacao, enviarEmailConfirmacaoLista, enviarEmailConfirmacaoListaMultipla, exigirLogin, exigirAdmin };
