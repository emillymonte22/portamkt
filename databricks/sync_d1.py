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
#   - tabelas criadas no D1 com d1/schema.sql

# COMMAND ----------

import json
import time
from datetime import datetime, timezone

import requests
from pyspark.sql import functions as F

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


def sincronizar(origem, destino):
    df = spark.table(origem).distinct()
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

for origem, destino in TABELAS.items():
    sincronizar(origem, destino)
