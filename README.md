# FACEIT Crosshair Code API

API simples que recebe um nickname FACEIT e responde somente o codigo da crosshair usado na partida mais recente encontrada.

## Rodar

```bash
cd C:\Rede\SITE\v2\faceit-crosshair-code-api
npm install
copy .env.example .env
npm run dev
```

Configure `FACEIT_API_KEY` no `.env`. A chave vem do FACEIT Developer Portal.

## Endpoint

```bash
curl http://localhost:3010/api/crosshair/NICK
```

Resposta de sucesso:

```text
CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx
```

## Como funciona

1. Busca o jogador pelo nickname na FACEIT Data API.
2. Busca a partida mais recente em `cs2` e, se nao encontrar, tenta `csgo`.
3. Procura um codigo `CSGO-...` nos payloads oficiais da partida/stats.
4. Se nao achar, consulta a pagina/rotas web da sala, incluindo as estatisticas avancadas onde a FACEIT mostra o botao Copiar.

Por padrao o projeto nao baixa demo. A ideia e usar somente a FACEIT e a tela de estatisticas avancadas.

## Estatisticas avancadas da FACEIT

O projeto ja tenta algumas URLs web provaveis da FACEIT. Se a FACEIT mudar o endpoint, abra o DevTools na tela da partida, clique em `Copiar` na coluna `Crosshair Code`, encontre a requisicao que traz o codigo e coloque a URL em `FACEIT_WEB_STATS_URLS`.

Use `{matchId}` como placeholder:

```env
FACEIT_WEB_STATS_URLS=https://www.faceit.com/api/alguma/rota/{matchId}/stats
```

Se essa rota exigir sua sessao logada, copie o header `cookie` do navegador para `FACEIT_WEB_COOKIE`.

Como o cookie costuma ser muito grande, tambem da para salvar em:

```text
C:\Rede\SITE\v2\faceit-crosshair-code-api\data\faceit-cookie.txt
```

e deixar no `.env`:

```env
FACEIT_WEB_COOKIE_FILE=data/faceit-cookie.txt
```

## Outros endpoints

- `GET /health`
- `GET /api/crosshair/:nickname`
- `GET /api/crosshair/:nickname?refresh=1` ignora cache
