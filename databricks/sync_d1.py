# Databricks notebook source
# Sincroniza tabelas do Databricks com o D1 (Cloudflare) usado pelo portal.
#
# Como funciona, para cada tabela:
#   1. lê a origem sem linhas repetidas e calcula um hash (sha256) de cada linha;
#   2. lê os hashes que já estão no D1;
#   3. insere só as linhas novas e apaga as que sumiram da origem.
# Linha alterada na origem = hash novo, então vira "apaga a antiga + insere a nova".
#
# Requisitos:
#   - secret `portamkt/cloudflare_token` (API Token do Cloudflare com permissão D1:Edit)
#   - secrets `BemolADL/client-id-cd`, `client-secret-cd`, `tenant-id-cd` (leitura da planilha no SharePoint)
#   - tabelas criadas no D1 com d1/schema.sql

# COMMAND ----------

import base64
import re
import time
import unicodedata
from datetime import date, datetime, timedelta, timezone
from io import BytesIO

import pandas as pd
import requests
from msal import ConfidentialClientApplication
from pyspark.sql import functions as F
from pyspark.sql.types import DoubleType, StringType, StructField, StructType

CF_ACCOUNT_ID = "4746b3c1373994e7d5599eb813e754fc"
D1_DATABASE_ID = "46af9aee-add1-421f-90c6-a87f847fca86"
CF_TOKEN = dbutils.secrets.get("portamkt", "cloudflare_token")

D1_URL = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/d1/database/{D1_DATABASE_ID}/query"

# origem no Databricks -> tabela no D1 (colunas viram minúsculas no D1)
TABELAS = {
    "comercial.logint.f_tracking_aereo": "tracking_aereo",
    "bemolonline.bol.dados_entregas_mkt_manifest_01": "entregas_mkt",
}

# Se a origem vier com menos da metade das linhas que já estão no D1, algo deu errado
# na origem (view quebrada, permissão, carga pela metade): aborta em vez de esvaziar o portal.
MIN_PROPORCAO = 0.5

STATEMENTS_POR_REQUEST = 200
HASHES_POR_DELETE = 90  # D1 aceita no máximo 100 parâmetros por statement

# COMMAND ----------

session = requests.Session()
session.headers.update({"Authorization": f"Bearer {CF_TOKEN}"})


def d1(body):
    """Envia {sql, params} ou {batch: [...]} ao D1, com retry simples em erro temporário."""
    for tentativa in range(5):
        resp = session.post(D1_URL, json=body, timeout=120)
        if resp.status_code == 429 or resp.status_code >= 500:
            time.sleep(2 ** tentativa)
            continue
        data = resp.json()
        if not data.get("success"):
            raise RuntimeError(f"D1 erro: {data.get('errors')}")
        return data["result"]
    resp.raise_for_status()
    raise RuntimeError(f"D1 indisponível após retries: {resp.status_code}")


def d1_batch(statements):
    for i in range(0, len(statements), STATEMENTS_POR_REQUEST):
        d1({"batch": statements[i : i + STATEMENTS_POR_REQUEST]})


def valor_sql(v):
    # D1 recebe parâmetros em JSON; Decimal e afins viram texto/número
    if v is None:
        return None
    if isinstance(v, (int, float, str)):
        return v
    return str(v)


# COMMAND ----------


def sincronizar(origem, destino, df=None):
    """origem: nome da tabela no Databricks (ou só um rótulo para o log, quando df é passado)."""
    df = (df if df is not None else spark.table(origem)).distinct()
    colunas = [c.lower() for c in df.columns]
    df = df.toDF(*colunas).withColumn(
        "row_hash", F.sha2(F.to_json(F.struct(*colunas)), 256)
    )
    df = df.dropDuplicates(["row_hash"])

    hashes_origem = {r.row_hash for r in df.select("row_hash").collect()}
    hashes_d1 = {
        r["row_hash"] for r in d1({"sql": f"SELECT row_hash FROM {destino}"})[0]["results"]
    }

    if hashes_d1 and len(hashes_origem) < len(hashes_d1) * MIN_PROPORCAO:
        raise RuntimeError(
            f"{origem}: origem tem {len(hashes_origem)} linhas e o D1 tem {len(hashes_d1)}. "
            "Abortando para não apagar dados do portal."
        )

    novos = hashes_origem - hashes_d1
    removidos = list(hashes_d1 - hashes_origem)

    # Insere primeiro e apaga depois: o portal nunca fica vazio no meio da sincronização
    if novos:
        cols = ["row_hash"] + colunas
        sql = (
            f"INSERT OR IGNORE INTO {destino} ({', '.join(cols)}) "
            f"VALUES ({', '.join('?' * len(cols))})"
        )
        novos_df = spark.createDataFrame([(h,) for h in novos], ["row_hash"])
        linhas = df.join(novos_df, "row_hash").select(*cols).collect()
        d1_batch([{"sql": sql, "params": [valor_sql(v) for v in linha]} for linha in linhas])

    if removidos:
        stmts = []
        for i in range(0, len(removidos), HASHES_POR_DELETE):
            lote = removidos[i : i + HASHES_POR_DELETE]
            stmts.append({
                "sql": f"DELETE FROM {destino} WHERE row_hash IN ({', '.join('?' * len(lote))})",
                "params": lote,
            })
        d1_batch(stmts)

    d1({
        "sql": "INSERT INTO sync_log (tabela, executado_em, total_origem, inseridos, removidos) VALUES (?, ?, ?, ?, ?)",
        "params": [destino, datetime.now(timezone.utc).isoformat(), len(hashes_origem), len(novos), len(removidos)],
    })
    print(f"{origem} -> {destino}: {len(hashes_origem)} linhas, +{len(novos)} / -{len(removidos)}")


# COMMAND ----------

# ---------- Planilha CONTROLE_AÉREO_2026.xlsx (SharePoint), aba "Marketplace" -> controle_aereo ----------
# Uma linha por coleta na planilha; a coluna NOTAS tem várias NFs separadas por "/". Aqui vira uma linha
# por NF (10 dígitos, igual a entregas_mkt.nota_fiscal_explode). Se a mesma NF aparecer em mais de uma
# coleta, fica a última linha da planilha. O portal usa só para completar o que falta no banco.

PLANILHA_URL = (
    "https://bemol-my.sharepoint.com/:x:/r/personal/emillymonte_bemol_com_br/_layouts/15/Doc.aspx"
    "?sourcedoc=%7BB4B387C6-0972-44E8-88BF-990B320E56CB%7D&file=CONTROLE_A%C3%89REO_2026.xlsx"
    "&action=default&mobileredirect=true"
)
PLANILHA_ABA = "Marketplace"

# coluna no D1 -> nomes possíveis na planilha (já normalizados e sem "_"), tipo
COLUNAS_PLANILHA = {
    "ncoleta":          (["ncoleta", "nocoleta", "coleta"], "texto"),
    "fornecedor":       (["fornecedor"], "texto"),
    "origem":           (["origem"], "texto"),
    "destino":          (["destino"], "texto"),
    "data_coleta":      (["datadacoleta", "datacoleta"], "data"),
    "transportadora":   (["transportadora"], "texto"),
    "notas":            (["notas", "notasfiscais", "nf"], "texto"),
    "cte":              (["ncte", "nocte", "cte"], "texto"),
    "volumes":          (["volumes", "volume"], "numero"),
    "peso":             (["peso"], "numero"),
    "data_cte":         (["datacte"], "data"),
    "valor_nota":       (["valordanota", "valornota"], "numero"),
    "valor_frete":      (["valortotaldefrete", "valorfrete"], "numero"),
    "previsao_entrega": (["previsaodeentrega", "previsaoentrega"], "data"),
    "chegada_mao":      (["chegadamao"], "data"),
    "agenda_cd":        (["agendacd"], "data"),
    "meta":             (["meta"], "numero"),
    "lead_time":        (["leadtime"], "numero"),
    "dias_atraso":      (["diasdeatraso", "diasatraso"], "numero"),
    "status":           (["status"], "texto"),
}


def baixar_planilha_sharepoint(url):
    """Mesmo acesso do notebook 'EXEMPLO CONSULTA EXCEL SHAREPOINT' (Graph API, app do CD)."""
    app = ConfidentialClientApplication(
        client_id=dbutils.secrets.get(scope="BemolADL", key="client-id-cd"),
        client_credential=dbutils.secrets.get(scope="BemolADL", key="client-secret-cd"),
        authority=f"https://login.microsoftonline.com/{dbutils.secrets.get(scope='BemolADL', key='tenant-id-cd')}",
    )
    token = app.acquire_token_for_client(scopes=["https://graph.microsoft.com/.default"])
    if "access_token" not in token:
        raise RuntimeError(f"Erro ao gerar token do SharePoint: {token.get('error_description')}")
    codigo = base64.urlsafe_b64encode(url.encode("utf-8")).decode("utf-8").rstrip("=")
    resp = requests.get(
        f"https://graph.microsoft.com/v1.0/shares/u!{codigo}/driveItem/content",
        headers={"Authorization": f"Bearer {token['access_token']}"},
        timeout=300,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Erro ao baixar a planilha: {resp.status_code} - {resp.text[:300]}")
    return resp.content


def chave_coluna(nome):
    nome = unicodedata.normalize("NFKD", str(nome).strip().lower()).encode("ASCII", "ignore").decode("utf-8")
    return re.sub(r"[^a-z0-9]", "", nome)


def para_texto(v):
    if v is None or (isinstance(v, float) and pd.isna(v)) or v is pd.NaT:
        return None
    if isinstance(v, float) and v.is_integer():
        v = int(v)  # 147117.0 -> "147117"
    t = str(v).strip()
    return t or None


def para_numero(v):
    if isinstance(v, (int, float)) and not pd.isna(v):
        return float(v)
    achado = re.search(r"-?\d+(?:[.,]\d+)?", str(v or ""))  # ex.: "DIAS DE ATRASO: 1"
    return float(achado.group().replace(",", ".")) if achado else None


def para_data(v):
    """Data da planilha -> 'AAAA-MM-DD' (aceita data do Excel, número serial ou texto DD/MM/AAAA)."""
    if v is None or v is pd.NaT or (isinstance(v, float) and pd.isna(v)):
        return None
    if isinstance(v, (datetime, date, pd.Timestamp)):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, (int, float)):
        return (date(1899, 12, 30) + timedelta(days=int(v))).isoformat() if 20000 < v < 80000 else None
    t = str(v).strip()
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", t)
    if m:
        return m.group(0)
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})", t)
    return f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}" if m else None


def ler_controle_aereo():
    pdf = pd.read_excel(BytesIO(baixar_planilha_sharepoint(PLANILHA_URL)), sheet_name=PLANILHA_ABA, dtype=object)
    por_chave = {chave_coluna(c): c for c in pdf.columns}
    origem_col = {}
    for destino, (nomes, _) in COLUNAS_PLANILHA.items():
        achada = next((por_chave[n] for n in nomes if n in por_chave), None)
        if achada is None and destino == "notas":
            raise RuntimeError(f"Aba {PLANILHA_ABA}: coluna NOTAS não encontrada. Colunas: {list(pdf.columns)}")
        origem_col[destino] = achada

    conversor = {"texto": para_texto, "numero": para_numero, "data": para_data}
    por_nf = {}
    for _, linha in pdf.iterrows():
        valores = {
            destino: (conversor[tipo](linha[origem_col[destino]]) if origem_col[destino] is not None else None)
            for destino, (_, tipo) in COLUNAS_PLANILHA.items()
        }
        for nf in re.findall(r"\d+", valores.pop("notas") or ""):
            nf = nf.lstrip("0")
            if nf:
                por_nf[nf.zfill(10)] = {"nota_fiscal_explode": nf.zfill(10), **valores}  # última coleta vence

    campos = ["nota_fiscal_explode"] + [c for c in COLUNAS_PLANILHA if c != "notas"]
    schema = StructType([
        StructField(c, DoubleType() if COLUNAS_PLANILHA.get(c, ([], "texto"))[1] == "numero" else StringType())
        for c in campos
    ])
    print(f"Planilha {PLANILHA_ABA}: {len(pdf)} coletas -> {len(por_nf)} NFs")
    return spark.createDataFrame([tuple(r[c] for c in campos) for r in por_nf.values()], schema)


# COMMAND ----------

# As tabelas do Databricks vão primeiro; se a planilha falhar (SharePoint fora, aba renomeada…), elas já foram
# atualizadas e o Job termina com erro no fim (o e-mail de falha avisa).
for origem, destino in TABELAS.items():
    sincronizar(origem, destino)

sincronizar(f"planilha {PLANILHA_ABA}", "controle_aereo", ler_controle_aereo())
