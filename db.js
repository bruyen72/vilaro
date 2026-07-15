// db.js — banco simples em arquivo JSON (sem compilação nativa, funciona em qualquer PC)
const fs = require('fs');
const path = require('path');

const ARQUIVO = path.join(__dirname, 'lista.json');
const PASTA_BACKUPS = path.join(__dirname, 'backups');
const INTERVALO_BACKUP_MS = 10 * 60 * 1000; // no máximo 1 backup novo a cada 10 minutos
const RETENCAO_BACKUP_MS = 30 * 24 * 60 * 60 * 1000; // apaga backups com mais de 30 dias

let ultimoBackup = 0;

function carregar() {
  if (!fs.existsSync(ARQUIVO)) {
    return { eventos: [], inscritos: [], gerentes: [], grupos: [], proximoIdEvento: 1, proximoIdInscrito: 1, proximoIdGerente: 1, proximoIdGrupo: 1 };
  }
  const data = JSON.parse(fs.readFileSync(ARQUIVO, 'utf-8'));
  if (!data.gerentes) data.gerentes = [];
  if (!data.proximoIdGerente) data.proximoIdGerente = 1;
  if (!data.grupos) data.grupos = [];
  if (!data.proximoIdGrupo) data.proximoIdGrupo = 1;
  return data;
}

function salvar(data) {
  fs.writeFileSync(ARQUIVO, JSON.stringify(data, null, 2));
  agendarBackup();
}

// Guarda uma cópia do banco de tempos em tempos, sem travar a resposta
// (a cópia roda em segundo plano). Assim, se o arquivo principal corromper
// ou for apagado sem querer, dá pra restaurar de uma cópia recente.
function agendarBackup() {
  const agora = Date.now();
  if (agora - ultimoBackup < INTERVALO_BACKUP_MS) return;
  ultimoBackup = agora;
  fazerBackup();
}

function fazerBackup() {
  fs.mkdir(PASTA_BACKUPS, { recursive: true }, (erroPasta) => {
    if (erroPasta) return console.error('Erro ao criar pasta de backups:', erroPasta.message);

    const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
    const destino = path.join(PASTA_BACKUPS, `lista-${carimbo}.json`);

    fs.copyFile(ARQUIVO, destino, (erroCopia) => {
      if (erroCopia) return console.error('Erro ao fazer backup do banco:', erroCopia.message);
      limparBackupsAntigos();
    });
  });
}

function limparBackupsAntigos() {
  fs.readdir(PASTA_BACKUPS, (erro, arquivos) => {
    if (erro) return;
    const agora = Date.now();
    arquivos
      .filter(nome => nome.startsWith('lista-') && nome.endsWith('.json'))
      .forEach(nome => {
        const caminho = path.join(PASTA_BACKUPS, nome);
        fs.stat(caminho, (erroStat, stats) => {
          if (erroStat) return;
          if (agora - stats.mtimeMs > RETENCAO_BACKUP_MS) {
            fs.unlink(caminho, () => {});
          }
        });
      });
  });
}

// Faz uma cópia assim que o servidor sobe, antes de qualquer escrita nova —
// garante que sempre existe pelo menos um backup recente do estado atual.
if (fs.existsSync(ARQUIVO)) {
  fazerBackup();
}

module.exports = { carregar, salvar };
