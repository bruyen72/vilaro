// server.js — API principal do sistema de lista VIP (sem dependência nativa)
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const ExcelJS = require('exceljs');
const { carregar, salvar } = require('./db');
const { hashSenha, compararSenha, gerarToken, enviarEmailRecuperacao, enviarEmailConfirmacaoLista, enviarEmailConfirmacaoListaMultipla, exigirLogin, exigirAdmin } = require('./auth');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(session({
  store: new FileStore({ path: './sessions', ttl: 60 * 60 * 8, retries: 0 }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 } // 8 horas
}));

// Páginas que só gerentes logados podem abrir; Eventos é só do administrador
const PAGINAS_ADMIN = ['/admin.html', '/gerenciar-rps.html'];
const PAGINAS_PROTEGIDAS = ['/dashboard.html', '/caixa.html', '/conta.html'];
app.use((req, res, next) => {
  if (PAGINAS_ADMIN.includes(req.path)) return exigirAdmin(req, res, next);
  if (PAGINAS_PROTEGIDAS.includes(req.path)) return exigirLogin(req, res, next);
  next();
});
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// ---------- CONFIG DE UPLOAD DE IMAGEM (banner) ----------
// Garante que a pasta existe: como ela é vazia, o Git não versiona ela sozinha
// (então não existe ainda logo depois de um clone/deploy novo, ex: no Render)
const PASTA_UPLOADS = path.join(__dirname, 'public/uploads');
require('fs').mkdirSync(PASTA_UPLOADS, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PASTA_UPLOADS),
  filename: (req, file, cb) => {
    const nomeUnico = Date.now() + path.extname(file.originalname);
    cb(null, nomeUnico);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // máx 5MB
  fileFilter: (req, file, cb) => {
    const tiposPermitidos = /jpeg|jpg|png|webp/;
    const ok = tiposPermitidos.test(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Só imagens JPG, PNG ou WEBP'), ok);
  }
});

function limparWhatsapp(numero) {
  return numero.replace(/\D/g, '');
}

function emailValido(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function formatarData() {
  return new Date().toLocaleString('pt-BR');
}

// Migra inscritos antigos que não têm número de senha e garante um valor por evento
function garantirNumeros(data) {
  const porEvento = {};
  let mudou = false;
  data.inscritos.forEach(i => {
    if (!porEvento[i.evento_id]) porEvento[i.evento_id] = 0;
    if (i.numero) {
      porEvento[i.evento_id] = Math.max(porEvento[i.evento_id], i.numero);
    }
  });
  data.inscritos.forEach(i => {
    if (!i.numero) {
      porEvento[i.evento_id] = (porEvento[i.evento_id] || 0) + 1;
      i.numero = porEvento[i.evento_id];
      mudou = true;
    }
  });
  if (mudou) salvar(data);
  return data;
}

function proximoNumero(data, evento_id) {
  const doEvento = data.inscritos.filter(i => i.evento_id == evento_id);
  const maior = doEvento.reduce((max, i) => Math.max(max, i.numero || 0), 0);
  return maior + 1;
}

// Cada grupo (lista de um RP dentro de um evento) tem numeração própria, começando do 1
function proximoNumeroGrupo(data, grupo_id) {
  const doGrupo = data.inscritos.filter(i => i.grupo_id == grupo_id);
  const maior = doGrupo.reduce((max, i) => Math.max(max, i.numero || 0), 0);
  return maior + 1;
}

function gerarSlugGrupo(data) {
  let slug;
  do {
    slug = Math.random().toString(36).slice(2, 8);
  } while (data.grupos.some(g => g.slug === slug));
  return slug;
}

// Garante que a coleção de grupos existe e migra inscritos antigos (sem grupo) para um
// grupo padrão por evento, ligado ao primeiro RP cadastrado, pra ninguém perder histórico
function garantirGrupos(data) {
  let mudou = false;

  data.eventos.forEach(ev => {
    const semGrupo = data.inscritos.some(i => i.evento_id === ev.id && !i.grupo_id);
    if (!semGrupo) return;

    let grupoPadrao = data.grupos.find(g => g.evento_id === ev.id && g.padrao);
    if (!grupoPadrao) {
      const primeiroGerente = data.gerentes[0];
      grupoPadrao = {
        id: data.proximoIdGrupo,
        evento_id: ev.id,
        rp_id: primeiroGerente ? primeiroGerente.id : null,
        rp_nome: primeiroGerente ? primeiroGerente.usuario : 'Geral',
        valor: ev.valor,
        slug: gerarSlugGrupo(data),
        padrao: true,
        criado_em: formatarData()
      };
      data.grupos.push(grupoPadrao);
      data.proximoIdGrupo++;
      mudou = true;
    }

    data.inscritos.forEach(i => {
      if (i.evento_id === ev.id && !i.grupo_id) {
        i.grupo_id = grupoPadrao.id;
        mudou = true;
      }
    });
  });

  if (mudou) salvar(data);
  return data;
}

// Garante que todo evento tenha um dono (criado_por), pra eventos criados antes
// dessa coluna existir também poderem ser excluídos pelo RP responsável por eles
function garantirCriadoPor(data) {
  let mudou = false;
  data.eventos.forEach(ev => {
    if (ev.criado_por === undefined || ev.criado_por === null) {
      const grupoPadrao = data.grupos.find(g => g.evento_id === ev.id && g.padrao);
      const primeiroGrupo = grupoPadrao || data.grupos.find(g => g.evento_id === ev.id);
      if (primeiroGrupo) {
        ev.criado_por = primeiroGrupo.rp_id;
        mudou = true;
      }
    }
  });
  if (mudou) salvar(data);
  return data;
}

// Garante que eventos antigos tenham os campos novos de início/fim
function garantirCamposEvento(data) {
  let mudou = false;
  data.eventos.forEach(ev => {
    if (ev.data_inicio === undefined) {
      ev.data_inicio = null;
      mudou = true;
    }
    if (ev.data_fim === undefined) {
      ev.data_fim = null;
      mudou = true;
    }
  });
  if (mudou) salvar(data);
  return data;
}

// Encerra sozinho só o evento que tem um horário de fim marcado e já passou
function fecharExpirados() {
  const data = garantirCamposEvento(carregar());
  const agora = new Date();
  let mudou = false;
  data.eventos.forEach(ev => {
    if (ev.ativo === 1 && ev.data_fim && new Date(ev.data_fim) <= agora) {
      ev.ativo = 0;
      mudou = true;
    }
  });
  if (mudou) salvar(data);
}
setInterval(fecharExpirados, 60 * 1000);
fecharExpirados();
garantirCriadoPor(garantirGrupos(carregar()));

// Garante que todo gerente antigo tenha um papel: o primeiro vira admin, os demais RP
function garantirRolesGerentes() {
  const data = carregar();
  let mudou = false;
  data.gerentes.forEach((g, idx) => {
    if (!g.role) {
      g.role = idx === 0 ? 'admin' : 'rp';
      mudou = true;
    }
  });
  if (mudou) salvar(data);
}
garantirRolesGerentes();

// Garante que sempre existe uma conta admin fixa (usuário/senha vêm do .env, nunca do código).
// Em hospedagens com disco temporário, o banco pode ser resetado a cada reinício/deploy —
// sem isso, o app achava que "ninguém tem conta ainda" e mostrava a tela de cadastro em vez
// da tela de login, e o dono do sistema podia ficar sem acesso de admin.
function garantirAdminPadrao() {
  const usuarioPadrao = process.env.ADMIN_PADRAO_USUARIO;
  const senhaPadrao = process.env.ADMIN_PADRAO_SENHA;
  if (!usuarioPadrao || !senhaPadrao) return;

  const data = carregar();
  const jaTemAdminPadrao = data.gerentes.some(g => g.usuario.toLowerCase() === usuarioPadrao.toLowerCase());
  if (!jaTemAdminPadrao) {
    data.gerentes.push({
      id: data.proximoIdGerente,
      usuario: usuarioPadrao,
      email: `${usuarioPadrao}@vilaro.local`,
      senhaHash: hashSenha(senhaPadrao),
      role: 'admin',
      resetToken: null,
      resetExpira: null
    });
    data.proximoIdGerente++;
    salvar(data);
  }
}
garantirAdminPadrao();

// ---------- CRIAR EVENTO ----------
app.post('/api/eventos', exigirLogin, (req, res) => {
  const { nome, valor, data_inicio, data_fim, banner_url, descricao } = req.body;
  if (!nome || !valor) {
    return res.status(400).json({ erro: 'Preencha nome e valor' });
  }

  const data = carregar();

  const jaExiste = data.eventos.some(e => e.nome.toLowerCase() === nome.toLowerCase());
  if (jaExiste) {
    return res.status(400).json({ erro: 'Já existe um evento com esse nome' });
  }

  const novoEvento = {
    id: data.proximoIdEvento,
    nome,
    valor: parseFloat(valor),
    ativo: 1,
    data_inicio: data_inicio || null,
    data_fim: data_fim || null,
    banner_url: banner_url || null,
    descricao: descricao || null,
    criado_por: req.session.gerenteId
  };

  data.eventos.push(novoEvento);
  data.proximoIdEvento++;
  salvar(data);

  res.json({ ok: true, evento_id: novoEvento.id });
});

// ---------- LISTAR EVENTOS ATIVOS ----------
app.get('/api/eventos', (req, res) => {
  const data = garantirGrupos(garantirCamposEvento(carregar()));
  const ativos = data.eventos.filter(e => e.ativo === 1);
  const comContagem = ativos.map(ev => {
    const total = data.inscritos.filter(i => i.evento_id === ev.id).length;
    const gruposEvento = data.grupos.filter(g => g.evento_id === ev.id);
    const valor_min = gruposEvento.length ? Math.min(...gruposEvento.map(g => g.valor)) : ev.valor;
    return { ...ev, inscritos: total, valor_min };
  });
  res.json(comContagem);
});

// ---------- LISTAR GRUPOS DE UM EVENTO (público, cliente escolhe por qual RP entrar) ----------
app.get('/api/eventos/:id/grupos', (req, res) => {
  const data = garantirGrupos(carregar());
  const evento = data.eventos.find(e => e.id == req.params.id && e.ativo === 1);
  if (!evento) return res.status(404).json({ erro: 'Evento não encontrado ou encerrado' });

  const grupos = data.grupos
    .filter(g => g.evento_id === evento.id)
    .map(g => ({ rp_nome: g.rp_nome, slug: g.slug }));
  res.json(grupos);
});

// ---------- LISTAR TODOS OS EVENTOS (inclusive encerrados, uso do admin) ----------
app.get('/api/eventos/todos', exigirAdmin, (req, res) => {
  const data = garantirCamposEvento(carregar());
  const comContagem = data.eventos.map(ev => {
    const total = data.inscritos.filter(i => i.evento_id === ev.id).length;
    return { ...ev, inscritos: total };
  });
  res.json(comContagem);
});

// ================= GRUPOS (lista própria de cada RP dentro de um evento) =================

// ---------- CRIAR MEU GRUPO NUM EVENTO (RP escolhe o próprio preço) ----------
app.post('/api/grupos', exigirLogin, (req, res) => {
  const { evento_id, valor } = req.body;
  if (!evento_id || valor === undefined || valor === null || valor === '') {
    return res.status(400).json({ erro: 'Escolha o evento e informe o valor do seu grupo' });
  }

  const data = garantirGrupos(carregar());
  const evento = data.eventos.find(e => e.id == evento_id);
  if (!evento) return res.status(404).json({ erro: 'Evento não encontrado' });

  const gerente = data.gerentes.find(g => g.id === req.session.gerenteId);
  const jaTemGrupo = data.grupos.some(g => g.evento_id == evento_id && g.rp_id === gerente.id);
  if (jaTemGrupo) {
    return res.status(400).json({ erro: 'Você já tem um grupo criado nesse evento' });
  }

  const grupo = {
    id: data.proximoIdGrupo,
    evento_id: parseInt(evento_id),
    rp_id: gerente.id,
    rp_nome: gerente.usuario,
    valor: parseFloat(valor),
    slug: gerarSlugGrupo(data),
    padrao: false,
    criado_em: formatarData()
  };
  data.grupos.push(grupo);
  data.proximoIdGrupo++;
  salvar(data);

  res.json({ ok: true, grupo });
});

// ---------- TROCAR O VALOR DO MEU GRUPO ----------
app.put('/api/grupos/:id', exigirLogin, (req, res) => {
  const { valor } = req.body;
  const data = garantirGrupos(carregar());
  const grupo = data.grupos.find(g => g.id == req.params.id);
  if (!grupo) return res.status(404).json({ erro: 'Grupo não encontrado' });
  if (grupo.rp_id !== req.session.gerenteId) {
    return res.status(403).json({ erro: 'Esse grupo não é seu' });
  }
  if (valor !== undefined) grupo.valor = parseFloat(valor);
  salvar(data);
  res.json({ ok: true, grupo });
});

// ---------- EXCLUIR MEU GRUPO (sai do evento sem apagar o evento nem os grupos dos outros RPs) ----------
app.delete('/api/grupos/:id', exigirLogin, (req, res) => {
  const data = garantirGrupos(carregar());
  const grupo = data.grupos.find(g => g.id == req.params.id);
  if (!grupo) return res.status(404).json({ erro: 'Grupo não encontrado' });

  const gerente = data.gerentes.find(g => g.id === req.session.gerenteId);
  if (grupo.rp_id !== req.session.gerenteId && gerente.role !== 'admin') {
    return res.status(403).json({ erro: 'Esse grupo não é seu' });
  }

  data.inscritos = data.inscritos.filter(i => i.grupo_id !== grupo.id);
  data.grupos = data.grupos.filter(g => g.id !== grupo.id);

  salvar(data);
  res.json({ ok: true });
});

// ---------- MEUS GRUPOS (o RP vê os próprios links, inscritos e pagos) ----------
app.get('/api/grupos/meus', exigirLogin, (req, res) => {
  const data = garantirCriadoPor(garantirGrupos(carregar()));
  const meus = data.grupos
    .filter(g => g.rp_id === req.session.gerenteId)
    .map(g => {
      const evento = data.eventos.find(e => e.id === g.evento_id);
      const doGrupo = data.inscritos.filter(i => i.grupo_id === g.id);
      const pagos = doGrupo.filter(i => i.pago);
      return {
        id: g.id,
        evento_id: g.evento_id,
        evento_nome: evento ? evento.nome : '(evento removido)',
        evento_ativo: evento ? evento.ativo === 1 : false,
        posso_excluir_evento: !!evento && evento.criado_por === req.session.gerenteId,
        valor: g.valor,
        slug: g.slug,
        inscritos: doGrupo.length,
        pagos: pagos.length,
        total_ganho: pagos.reduce((soma, i) => soma + (Number(i.valor_pago) || 0), 0)
      };
    });
  res.json(meus);
});

// ---------- VER GRUPO PELO LINK (público, usado na página de inscrição do RP) ----------
app.get('/api/grupo/:slug', (req, res) => {
  const data = garantirGrupos(carregar());
  const grupo = data.grupos.find(g => g.slug === req.params.slug);
  if (!grupo) return res.status(404).json({ erro: 'Link inválido' });

  const evento = data.eventos.find(e => e.id === grupo.evento_id);
  if (!evento || evento.ativo !== 1) {
    return res.status(404).json({ erro: 'Evento não encontrado ou encerrado' });
  }

  const totalGrupo = data.inscritos.filter(i => i.grupo_id === grupo.id).length;

  res.json({
    evento_id: evento.id,
    nome: evento.nome,
    descricao: evento.descricao,
    banner_url: evento.banner_url,
    valor: grupo.valor,
    rp_nome: grupo.rp_nome,
    inscritos: totalGrupo
  });
});

// Máximo de amigos que dá pra colocar junto numa mesma inscrição (evita abuso do campo)
const MAX_AMIGOS_POR_INSCRICAO = 20;

// ---------- INSCREVER NA LISTA DE UM GRUPO (via link do RP) ----------
app.post('/api/inscricao-grupo', async (req, res) => {
  const { slug, nome_completo, whatsapp, email, amigos } = req.body;

  if (!slug || !nome_completo || !whatsapp || !email) {
    return res.status(400).json({ erro: 'Preencha nome completo, whatsapp e e-mail' });
  }
  if (!emailValido(email)) {
    return res.status(400).json({ erro: 'Informe um e-mail válido' });
  }

  const data = garantirGrupos(carregar());
  const grupo = data.grupos.find(g => g.slug === slug);
  if (!grupo) return res.status(404).json({ erro: 'Link inválido' });

  const evento = data.eventos.find(e => e.id === grupo.evento_id && e.ativo === 1);
  if (!evento) return res.status(404).json({ erro: 'Evento não encontrado ou encerrado' });

  const whatsappLimpo = limparWhatsapp(whatsapp);
  const emailLimpo = email.trim().toLowerCase();

  // Nomes dos amigos que a pessoa quer colocar junto na mesma inscrição, além dela mesma
  const nomesAmigos = Array.isArray(amigos)
    ? amigos.map(a => String(a).trim()).filter(Boolean).slice(0, MAX_AMIGOS_POR_INSCRICAO)
    : [];

  const nomesPessoas = [nome_completo.trim(), ...nomesAmigos];

  const inseridos = [];
  const jaEstavam = [];

  for (const nome of nomesPessoas) {
    const nomeLimpo = nome.toLowerCase();
    // Dedup dentro do próprio envio (ex: digitou o mesmo amigo duas vezes)
    if (inseridos.some(p => p.nome_completo.toLowerCase() === nomeLimpo)) continue;

    const jaInscrito = data.inscritos.find(i =>
      i.evento_id === evento.id &&
      i.nome_completo.trim().toLowerCase() === nomeLimpo &&
      (i.whatsapp === whatsappLimpo || (i.email && i.email.toLowerCase() === emailLimpo))
    );
    if (jaInscrito) {
      jaEstavam.push({ nome_completo: nome, numero: jaInscrito.numero });
      continue;
    }

    const numero = proximoNumeroGrupo(data, grupo.id);
    const novoInscrito = {
      id: data.proximoIdInscrito,
      evento_id: evento.id,
      grupo_id: grupo.id,
      numero,
      nome_completo: nome,
      whatsapp: whatsappLimpo,
      email: email.trim(),
      pago: false,
      valor_pago: null,
      checkin_em: null,
      criado_em: formatarData()
    };
    data.inscritos.push(novoInscrito);
    data.proximoIdInscrito++;
    inseridos.push(novoInscrito);
  }

  if (inseridos.length) salvar(data);

  // Número "principal" da resposta: o da própria pessoa (novo ou já existente)
  const principalNovo = inseridos.find(p => p.nome_completo === nome_completo.trim());
  const principalExistia = jaEstavam.find(p => p.nome_completo === nome_completo.trim());
  const principal = principalNovo || principalExistia || inseridos[0] || jaEstavam[0];

  res.json({
    ok: true,
    mensagem: 'Você entrou na lista!',
    numero: principal.numero,
    ja_estava: !!principalExistia,
    amigos: inseridos.filter(p => p.nome_completo !== nome_completo.trim()).map(p => ({ nome_completo: p.nome_completo, numero: p.numero })),
    ja_estavam: jaEstavam.map(p => ({ nome_completo: p.nome_completo, numero: p.numero }))
  });

  // Manda o e-mail depois de já ter respondido: o cliente vê o número na hora,
  // sem esperar o Gmail. Importante numa fila lotada, onde várias pessoas
  // se cadastram ao mesmo tempo e cada e-mail pode demorar 1-2s pra sair.
  if (!inseridos.length) return;

  if (inseridos.length === 1) {
    enviarEmailConfirmacaoLista(email.trim(), {
      nome_completo: inseridos[0].nome_completo,
      numero: inseridos[0].numero,
      evento_nome: evento.nome,
      rp_nome: grupo.rp_nome
    }).catch(e => console.error('Erro ao enviar e-mail de confirmação:', e.message));
  } else {
    enviarEmailConfirmacaoListaMultipla(email.trim(), {
      pessoas: inseridos.map(p => ({ nome_completo: p.nome_completo, numero: p.numero })),
      evento_nome: evento.nome,
      rp_nome: grupo.rp_nome
    }).catch(e => console.error('Erro ao enviar e-mail de confirmação (múltiplo):', e.message));
  }
});

// ---------- ESQUECI MEU NÚMERO (cliente consulta pelo whatsapp que usou, sem precisar de conta) ----------
app.get('/api/meu-numero/:whatsapp', (req, res) => {
  const whatsappLimpo = limparWhatsapp(req.params.whatsapp);
  if (!whatsappLimpo) return res.status(400).json({ erro: 'Informe o whatsapp' });

  const data = garantirGrupos(carregar());
  const encontrados = data.inscritos
    .filter(i => i.whatsapp === whatsappLimpo)
    .map(i => {
      const grupo = data.grupos.find(g => g.id === i.grupo_id);
      const evento = data.eventos.find(e => e.id === i.evento_id);
      return {
        evento_nome: evento ? evento.nome : '(evento removido)',
        rp_nome: grupo ? grupo.rp_nome : null,
        numero: i.numero,
        pago: !!i.pago
      };
    });

  res.json(encontrados);
});

// ---------- INSCREVER NA LISTA ----------
app.post('/api/inscricao', (req, res) => {
  const { evento_id, nome_completo, whatsapp, email } = req.body;

  if (!evento_id || !nome_completo || !whatsapp || !email) {
    return res.status(400).json({ erro: 'Preencha nome completo, whatsapp e e-mail' });
  }
  if (!emailValido(email)) {
    return res.status(400).json({ erro: 'Informe um e-mail válido' });
  }

  const data = garantirNumeros(carregar());
  const evento = data.eventos.find(e => e.id == evento_id && e.ativo === 1);
  if (!evento) {
    return res.status(404).json({ erro: 'Evento não encontrado ou encerrado' });
  }

  const whatsappLimpo = limparWhatsapp(whatsapp);

  const emailLimpo = email.trim().toLowerCase();
  const nomeLimpo = nome_completo.trim().toLowerCase();
  const jaInscrito = data.inscritos.find(i =>
    i.evento_id == evento_id &&
    i.nome_completo.trim().toLowerCase() === nomeLimpo &&
    (i.whatsapp === whatsappLimpo || (i.email && i.email.toLowerCase() === emailLimpo))
  );
  if (jaInscrito) {
    return res.status(409).json({ erro: 'Esse WhatsApp ou e-mail já está nesta lista', numero: jaInscrito.numero });
  }

  const numero = proximoNumero(data, evento_id);

  data.inscritos.push({
    id: data.proximoIdInscrito,
    evento_id: parseInt(evento_id),
    numero,
    nome_completo: nome_completo.trim(),
    whatsapp: whatsappLimpo,
    email: email.trim(),
    pago: false,
    valor_pago: null,
    checkin_em: null,
    criado_em: formatarData()
  });
  data.proximoIdInscrito++;
  salvar(data);

  res.json({ ok: true, mensagem: 'Você entrou na lista!', numero });
});

// ---------- EDITAR EVENTO (admin: nome, valor, descrição, início/fim) ----------
app.put('/api/eventos/:id', exigirAdmin, (req, res) => {
  const { nome, valor, descricao, data_inicio, data_fim } = req.body;
  const data = carregar();
  const evento = data.eventos.find(e => e.id == req.params.id);
  if (!evento) return res.status(404).json({ erro: 'Evento não encontrado' });

  if (nome !== undefined) {
    const nomeLimpo = nome.trim();
    if (!nomeLimpo) return res.status(400).json({ erro: 'O nome não pode ficar em branco' });
    const jaExiste = data.eventos.some(e => e.id !== evento.id && e.nome.toLowerCase() === nomeLimpo.toLowerCase());
    if (jaExiste) return res.status(400).json({ erro: 'Já existe um evento com esse nome' });
    evento.nome = nomeLimpo;
  }
  if (valor !== undefined) evento.valor = parseFloat(valor);
  if (descricao !== undefined) evento.descricao = descricao;
  if (data_inicio !== undefined) evento.data_inicio = data_inicio || null;
  if (data_fim !== undefined) evento.data_fim = data_fim || null;

  salvar(data);
  res.json({ ok: true });
});

// ---------- UPLOAD DE BANNER (troca imagem do evento) ----------
app.post('/api/eventos/:id/banner', exigirAdmin, upload.single('imagem'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Envie uma imagem no campo "imagem"' });

  const data = carregar();
  const evento = data.eventos.find(e => e.id == req.params.id);
  if (!evento) return res.status(404).json({ erro: 'Evento não encontrado' });

  const banner_url = '/uploads/' + req.file.filename;
  evento.banner_url = banner_url;
  salvar(data);

  res.json({ ok: true, banner_url });
});

// ---------- REMOVER BANNER DO EVENTO ----------
app.delete('/api/eventos/:id/banner', exigirAdmin, (req, res) => {
  const data = carregar();
  const evento = data.eventos.find(e => e.id == req.params.id);
  if (!evento) return res.status(404).json({ erro: 'Evento não encontrado' });

  evento.banner_url = null;
  salvar(data);
  res.json({ ok: true });
});

// ---------- EXCLUIR EVENTO (apaga o evento, os grupos e os inscritos ligados a ele) ----------
// Admin exclui qualquer evento. RP só pode excluir o evento que ele mesmo criou (corrigir erro seu).
app.delete('/api/eventos/:id', exigirLogin, (req, res) => {
  const data = garantirCriadoPor(garantirGrupos(carregar()));
  const evento = data.eventos.find(e => e.id == req.params.id);
  if (!evento) return res.status(404).json({ erro: 'Evento não encontrado' });

  const gerente = data.gerentes.find(g => g.id === req.session.gerenteId);
  const souCriador = evento.criado_por === req.session.gerenteId;
  if (gerente.role !== 'admin' && !souCriador) {
    return res.status(403).json({ erro: 'Você só pode excluir um evento que você mesmo criou' });
  }

  data.inscritos = data.inscritos.filter(i => i.evento_id !== evento.id);
  data.grupos = data.grupos.filter(g => g.evento_id !== evento.id);
  data.eventos = data.eventos.filter(e => e.id !== evento.id);

  salvar(data);
  res.json({ ok: true });
});

// ---------- ADICIONAR CONVIDADO MANUALMENTE (RP adiciona no próprio grupo, ignora limite de vagas) ----------
app.post('/api/inscricao-manual', exigirLogin, (req, res) => {
  const { grupo_id, nome_completo, whatsapp, email } = req.body;

  if (!grupo_id || !nome_completo || !whatsapp) {
    return res.status(400).json({ erro: 'Preencha nome completo e whatsapp' });
  }
  if (email && !emailValido(email)) {
    return res.status(400).json({ erro: 'Informe um e-mail válido' });
  }

  const data = garantirGrupos(garantirNumeros(carregar()));
  const grupo = data.grupos.find(g => g.id == grupo_id);
  if (!grupo) return res.status(404).json({ erro: 'Grupo não encontrado' });
  if (grupo.rp_id !== req.session.gerenteId) {
    return res.status(403).json({ erro: 'Esse grupo não é seu' });
  }

  const whatsappLimpo = limparWhatsapp(whatsapp);
  const numero = proximoNumeroGrupo(data, grupo.id);

  data.inscritos.push({
    id: data.proximoIdInscrito,
    evento_id: grupo.evento_id,
    grupo_id: grupo.id,
    numero,
    nome_completo: nome_completo.trim(),
    whatsapp: whatsappLimpo,
    email: email ? email.trim() : null,
    pago: false,
    valor_pago: null,
    checkin_em: null,
    criado_em: formatarData(),
    adicionado_manualmente: true
  });
  data.proximoIdInscrito++;
  salvar(data);

  res.json({ ok: true, numero });
});

// ---------- VER LISTA COMPLETA DO MEU GRUPO (dashboard, uso interno) ----------
app.get('/api/lista/:grupo_id', exigirLogin, (req, res) => {
  const data = garantirGrupos(garantirNumeros(carregar()));
  const grupo = data.grupos.find(g => g.id == req.params.grupo_id);
  if (!grupo) return res.status(404).json({ erro: 'Grupo não encontrado' });
  if (grupo.rp_id !== req.session.gerenteId) {
    return res.status(403).json({ erro: 'Esse grupo não é seu' });
  }

  const inscritos = data.inscritos
    .filter(i => i.grupo_id == grupo.id)
    .sort((a, b) => a.numero - b.numero)
    .map(i => ({
      numero: i.numero,
      nome_completo: i.nome_completo,
      whatsapp: i.whatsapp,
      email: i.email || '',
      criado_em: i.criado_em,
      pago: !!i.pago,
      valor_pago: i.valor_pago
    }));
  res.json(inscritos);
});

// ---------- EXPORTAR LISTA COMPLETA DO MEU GRUPO EM EXCEL (.xlsx) ----------
app.get('/api/lista/:grupo_id/exportar', exigirLogin, async (req, res) => {
  const data = garantirGrupos(garantirNumeros(carregar()));
  const grupo = data.grupos.find(g => g.id == req.params.grupo_id);
  if (!grupo) return res.status(404).json({ erro: 'Grupo não encontrado' });
  if (grupo.rp_id !== req.session.gerenteId) {
    return res.status(403).json({ erro: 'Esse grupo não é seu' });
  }

  const evento = data.eventos.find(e => e.id === grupo.evento_id);

  const inscritos = data.inscritos
    .filter(i => i.grupo_id == grupo.id)
    .sort((a, b) => a.numero - b.numero);

  const workbook = new ExcelJS.Workbook();
  const planilha = workbook.addWorksheet('Lista');

  planilha.columns = [
    { header: 'Número', key: 'numero', width: 10 },
    { header: 'Nome completo', key: 'nome_completo', width: 30 },
    { header: 'WhatsApp', key: 'whatsapp', width: 18 },
    { header: 'E-mail', key: 'email', width: 28 },
    { header: 'Entrou em', key: 'criado_em', width: 20 },
    { header: 'Pago', key: 'pago', width: 10 },
    { header: 'Valor pago', key: 'valor_pago', width: 14 }
  ];
  planilha.getRow(1).font = { bold: true };

  const corVerde = 'FFD9EAD3';
  const corVermelha = 'FFF4CCCC';

  inscritos.forEach(i => {
    const linha = planilha.addRow({
      numero: i.numero,
      nome_completo: i.nome_completo,
      whatsapp: i.whatsapp,
      email: i.email || '',
      criado_em: i.criado_em,
      pago: i.pago ? 'Sim' : 'Não',
      valor_pago: i.valor_pago || ''
    });
    const cor = i.pago ? corVerde : corVermelha;
    linha.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: cor } };
    });
  });

  const nomeArquivo = `lista-${(evento ? evento.nome : 'evento').replace(/[^a-z0-9]+/gi, '-')}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
  await workbook.xlsx.write(res);
  res.end();
});

// ---------- CAIXA: ESTATÍSTICAS DE CHECK-IN DE UM EVENTO (pra gráfico de acompanhamento) ----------
// RP só vê o próprio número, nunca o de outro RP. Só o admin vê todo mundo junto.
app.get('/api/caixa-stats/:evento_id', exigirLogin, (req, res) => {
  const data = garantirGrupos(carregar());
  const gerente = data.gerentes.find(g => g.id === req.session.gerenteId);

  let gruposDoEvento = data.grupos.filter(g => g.evento_id == req.params.evento_id);
  const somenteMeu = !gerente || gerente.role !== 'admin';
  if (somenteMeu) {
    gruposDoEvento = gruposDoEvento.filter(g => g.rp_id === req.session.gerenteId);
  }

  const porRp = gruposDoEvento.map(g => {
    const doGrupo = data.inscritos.filter(i => i.grupo_id === g.id);
    return {
      rp_nome: g.rp_nome,
      inscritos: doGrupo.length,
      pagos: doGrupo.filter(i => i.pago).length
    };
  }).sort((a, b) => b.pagos - a.pagos);

  const totalInscritos = porRp.reduce((soma, r) => soma + r.inscritos, 0);
  const totalPagos = porRp.reduce((soma, r) => soma + r.pagos, 0);

  res.json({ totalInscritos, totalPagos, porRp, somenteMeu });
});

// ---------- CAIXA: BUSCAR NÚMERO EM TODOS OS GRUPOS DE UM EVENTO (qualquer gerente logado pode conferir) ----------
app.get('/api/caixa-busca/:evento_id/:numero', exigirLogin, (req, res) => {
  const data = garantirGrupos(garantirNumeros(carregar()));
  const gruposDoEvento = data.grupos.filter(g => g.evento_id == req.params.evento_id);

  const encontrados = gruposDoEvento
    .map(g => {
      const inscrito = data.inscritos.find(i => i.grupo_id === g.id && i.numero == req.params.numero);
      if (!inscrito) return null;
      return {
        grupo_id: g.id,
        rp_nome: g.rp_nome,
        numero: inscrito.numero,
        nome_completo: inscrito.nome_completo,
        whatsapp: inscrito.whatsapp,
        pago: !!inscrito.pago,
        valor_pago: inscrito.valor_pago,
        checkin_em: inscrito.checkin_em,
        valor_sugerido: g.valor
      };
    })
    .filter(Boolean);

  res.json(encontrados);
});

// ---------- CAIXA: BUSCAR INSCRITO PELO NÚMERO (senha) NUM GRUPO ESPECÍFICO ----------
app.get('/api/caixa/:grupo_id/:numero', exigirLogin, (req, res) => {
  const data = garantirGrupos(garantirNumeros(carregar()));
  const grupo = data.grupos.find(g => g.id == req.params.grupo_id);
  if (!grupo) return res.status(404).json({ erro: 'Grupo não encontrado' });

  const inscrito = data.inscritos.find(i => i.grupo_id == grupo.id && i.numero == req.params.numero);
  if (!inscrito) return res.status(404).json({ erro: 'Ninguém encontrado com esse número' });

  res.json({
    numero: inscrito.numero,
    nome_completo: inscrito.nome_completo,
    whatsapp: inscrito.whatsapp,
    pago: !!inscrito.pago,
    valor_pago: inscrito.valor_pago,
    checkin_em: inscrito.checkin_em,
    valor_sugerido: grupo.valor
  });
});

// ---------- CAIXA: CONFIRMAR PAGAMENTO / ENTRADA NUM GRUPO ESPECÍFICO ----------
app.post('/api/caixa/:grupo_id/:numero', exigirLogin, (req, res) => {
  const { valor_pago } = req.body;
  const data = garantirGrupos(garantirNumeros(carregar()));
  const grupo = data.grupos.find(g => g.id == req.params.grupo_id);
  if (!grupo) return res.status(404).json({ erro: 'Grupo não encontrado' });

  const inscrito = data.inscritos.find(i => i.grupo_id == grupo.id && i.numero == req.params.numero);
  if (!inscrito) return res.status(404).json({ erro: 'Ninguém encontrado com esse número' });

  inscrito.pago = true;
  inscrito.valor_pago = parseFloat(valor_pago);
  inscrito.checkin_em = formatarData();
  salvar(data);

  res.json({ ok: true, inscrito });
});

// ---------- FECHAR EVENTO MANUALMENTE ----------
app.post('/api/eventos/:id/fechar', exigirAdmin, (req, res) => {
  const data = carregar();
  const evento = data.eventos.find(e => e.id == req.params.id);
  if (evento) {
    evento.ativo = 0;
    salvar(data);
  }
  res.json({ ok: true });
});

// ---------- REABRIR EVENTO MANUALMENTE ----------
app.post('/api/eventos/:id/reabrir', exigirAdmin, (req, res) => {
  const data = garantirCamposEvento(carregar());
  const evento = data.eventos.find(e => e.id == req.params.id);
  if (evento) {
    evento.ativo = 1;
    // se o fim marcado já passou, limpa pra não fechar sozinho de novo na próxima checagem
    if (evento.data_fim && new Date(evento.data_fim) <= new Date()) {
      evento.data_fim = null;
    }
    salvar(data);
  }
  res.json({ ok: true });
});

// ================= AUTENTICAÇÃO DE GERENTES =================

// ---------- REGISTRAR GERENTE (primeiro cadastro é livre; os demais exigem login) ----------
app.post('/api/registrar-gerente', (req, res) => {
  const { usuario, email, senha } = req.body;
  if (!usuario || !email || !senha) {
    return res.status(400).json({ erro: 'Preencha usuário, e-mail e senha' });
  }
  if (senha.length < 6) {
    return res.status(400).json({ erro: 'A senha precisa ter pelo menos 6 caracteres' });
  }

  const data = carregar();

  const precisaEstarLogado = data.gerentes.length > 0;
  if (precisaEstarLogado && !(req.session && req.session.gerenteId)) {
    return res.status(401).json({ erro: 'Faça login para cadastrar outro RP' });
  }

  const jaExiste = data.gerentes.some(g =>
    g.usuario.toLowerCase() === usuario.toLowerCase() || g.email.toLowerCase() === email.toLowerCase()
  );
  if (jaExiste) {
    return res.status(400).json({ erro: 'Já existe um RP com esse usuário ou e-mail' });
  }

  const novoGerente = {
    id: data.proximoIdGerente,
    usuario,
    email,
    senhaHash: hashSenha(senha),
    role: precisaEstarLogado ? 'rp' : 'admin',
    resetToken: null,
    resetExpira: null
  };
  data.gerentes.push(novoGerente);
  data.proximoIdGerente++;
  salvar(data);

  if (!precisaEstarLogado) {
    req.session.gerenteId = novoGerente.id;
  }

  res.json({ ok: true });
});

// ---------- LOGIN ----------
app.post('/api/login', (req, res) => {
  const { usuario, senha } = req.body;
  if (!usuario || !senha) {
    return res.status(400).json({ erro: 'Preencha usuário e senha' });
  }

  const data = carregar();
  const gerente = data.gerentes.find(g =>
    g.usuario.toLowerCase() === usuario.toLowerCase() || g.email.toLowerCase() === usuario.toLowerCase()
  );
  if (!gerente || !compararSenha(senha, gerente.senhaHash)) {
    return res.status(401).json({ erro: 'Usuário ou senha incorretos' });
  }

  req.session.gerenteId = gerente.id;
  res.json({ ok: true, usuario: gerente.usuario, role: gerente.role });
});

// ---------- LOGOUT ----------
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---------- SESSÃO ATUAL ----------
app.get('/api/sessao', (req, res) => {
  if (!req.session || !req.session.gerenteId) return res.json({ logado: false });
  const data = carregar();
  const gerente = data.gerentes.find(g => g.id === req.session.gerenteId);
  if (!gerente) return res.json({ logado: false });
  res.json({ logado: true, usuario: gerente.usuario, email: gerente.email, role: gerente.role });
});

// ---------- TROCAR MINHA SENHA (já logado, precisa confirmar a senha atual) ----------
app.post('/api/trocar-senha', exigirLogin, (req, res) => {
  const { senhaAtual, novaSenha } = req.body;
  if (!senhaAtual || !novaSenha) {
    return res.status(400).json({ erro: 'Preencha a senha atual e a nova senha' });
  }
  if (novaSenha.length < 6) {
    return res.status(400).json({ erro: 'A nova senha precisa ter pelo menos 6 caracteres' });
  }

  const data = carregar();
  const gerente = data.gerentes.find(g => g.id === req.session.gerenteId);
  if (!compararSenha(senhaAtual, gerente.senhaHash)) {
    return res.status(401).json({ erro: 'Senha atual incorreta' });
  }

  gerente.senhaHash = hashSenha(novaSenha);
  salvar(data);
  res.json({ ok: true });
});

// ---------- LISTAR TODOS OS GERENTES COM ESTATÍSTICAS (admin gerencia contas) ----------
app.get('/api/gerentes', exigirAdmin, (req, res) => {
  const data = garantirGrupos(carregar());
  const lista = data.gerentes.map(g => {
    const gruposDele = data.grupos.filter(gr => gr.rp_id === g.id);
    const idsGrupos = gruposDele.map(gr => gr.id);
    const inscritosDele = data.inscritos.filter(i => idsGrupos.includes(i.grupo_id));
    const pagosDele = inscritosDele.filter(i => i.pago);
    return {
      id: g.id,
      usuario: g.usuario,
      email: g.email,
      role: g.role,
      grupos: gruposDele.length,
      inscritos: inscritosDele.length,
      pagos: pagosDele.length,
      total_ganho: pagosDele.reduce((soma, i) => soma + (Number(i.valor_pago) || 0), 0)
    };
  });
  res.json(lista);
});

// ---------- ADMIN TROCA A SENHA DE QUALQUER GERENTE (sem precisar de e-mail) ----------
app.put('/api/gerentes/:id/senha', exigirAdmin, (req, res) => {
  const { novaSenha } = req.body;
  if (!novaSenha || novaSenha.length < 6) {
    return res.status(400).json({ erro: 'A nova senha precisa ter pelo menos 6 caracteres' });
  }

  const data = carregar();
  const gerente = data.gerentes.find(g => g.id == req.params.id);
  if (!gerente) return res.status(404).json({ erro: 'Conta não encontrada' });

  gerente.senhaHash = hashSenha(novaSenha);
  gerente.resetToken = null;
  gerente.resetExpira = null;
  salvar(data);
  res.json({ ok: true });
});

// ---------- ADMIN PROMOVE/REBAIXA UMA CONTA ENTRE ADMIN E RP ----------
app.put('/api/gerentes/:id/role', exigirAdmin, (req, res) => {
  const { role } = req.body;
  if (role !== 'admin' && role !== 'rp') {
    return res.status(400).json({ erro: 'Papel inválido' });
  }

  const data = carregar();
  const gerente = data.gerentes.find(g => g.id == req.params.id);
  if (!gerente) return res.status(404).json({ erro: 'Conta não encontrada' });

  if (gerente.role === 'admin' && role === 'rp') {
    const outrosAdmins = data.gerentes.filter(g => g.role === 'admin' && g.id !== gerente.id);
    if (outrosAdmins.length === 0) {
      return res.status(400).json({ erro: 'Precisa ter pelo menos um administrador' });
    }
  }

  gerente.role = role;
  salvar(data);
  res.json({ ok: true });
});

// ---------- ADMIN EXCLUI A CONTA DE UM GERENTE (mantém os grupos e inscritos como histórico) ----------
app.delete('/api/gerentes/:id', exigirAdmin, (req, res) => {
  const data = carregar();
  const gerente = data.gerentes.find(g => g.id == req.params.id);
  if (!gerente) return res.status(404).json({ erro: 'Conta não encontrada' });

  if (gerente.id === req.session.gerenteId) {
    return res.status(400).json({ erro: 'Você não pode excluir a própria conta por aqui' });
  }
  if (gerente.role === 'admin') {
    const outrosAdmins = data.gerentes.filter(g => g.role === 'admin' && g.id !== gerente.id);
    if (outrosAdmins.length === 0) {
      return res.status(400).json({ erro: 'Precisa ter pelo menos um administrador' });
    }
  }

  data.gerentes = data.gerentes.filter(g => g.id !== gerente.id);
  salvar(data);
  res.json({ ok: true });
});

// ---------- HÁ ALGUM GERENTE CADASTRADO? (front decide se mostra "criar conta" ou "login") ----------
app.get('/api/gerentes/existe', (req, res) => {
  const data = carregar();
  res.json({ existe: data.gerentes.length > 0 });
});

// ---------- ESQUECI MINHA SENHA (envia e-mail) ----------
app.post('/api/esqueci-senha', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ erro: 'Informe seu e-mail' });

  const data = carregar();
  const gerente = data.gerentes.find(g => g.email.toLowerCase() === email.toLowerCase());

  if (gerente) {
    gerente.resetToken = gerarToken();
    gerente.resetExpira = Date.now() + 30 * 60 * 1000; // 30 minutos
    salvar(data);

    const link = `${req.protocol}://${req.get('host')}/redefinir-senha.html?token=${gerente.resetToken}`;
    try {
      await enviarEmailRecuperacao(gerente.email, link);
    } catch (e) {
      console.error('Erro ao enviar e-mail:', e.message);
      return res.status(500).json({ erro: 'Não consegui enviar o e-mail agora. Tente novamente.' });
    }
  }

  // Sempre responde ok, mesmo se o e-mail não existir (evita confirmar quem tem conta)
  res.json({ ok: true, mensagem: 'Se esse e-mail estiver cadastrado, você vai receber um link de recuperação.' });
});

// ---------- REDEFINIR SENHA (com token do e-mail) ----------
app.post('/api/redefinir-senha', (req, res) => {
  const { token, novaSenha } = req.body;
  if (!token || !novaSenha) return res.status(400).json({ erro: 'Dados inválidos' });
  if (novaSenha.length < 6) return res.status(400).json({ erro: 'A senha precisa ter pelo menos 6 caracteres' });

  const data = carregar();
  const gerente = data.gerentes.find(g => g.resetToken === token && g.resetExpira > Date.now());
  if (!gerente) return res.status(400).json({ erro: 'Link inválido ou expirado. Peça um novo.' });

  gerente.senhaHash = hashSenha(novaSenha);
  gerente.resetToken = null;
  gerente.resetExpira = null;
  salvar(data);

  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
