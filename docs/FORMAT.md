# ファイルの形

受け渡しはすべて iCloud Drive の1つのフォルダで行う（シュタイナーの講演録なら `シュタイナー読み上げ/修正作業/`）。

## 講（Mac → アプリ）: `<講のid>.json` ＋ `<audioFile>`

```json
{
  "format": "tts-review/chapter", "version": 1,
  "id": "GA104_黙示録の秘密_第01講",
  "audioId": "100eebb440ccc67a",          // m4a の sha1 の頭16字。版の見分けに使う
  "title": "…", "album": "…", "artist": "…", "heading": "第1講 …",
  "audioFile": "GA104_黙示録の秘密_第01講.m4a", "audioSize": 16959115, "duration": 2150.26,
  "units": [
    { "i": 0, "kind": "heading|para|sentence|inner", "t0": 0.0, "t1": 4.9,
      "display": "画面に出す文", "read": "合成器に渡した字", "key": "倉庫のキー" }
  ]
}
```

`t0` は文の鳴り始め、`t1` は鳴り終わり（次の文との間の手前）。アプリは `t0` で「いまどこか」を決め、「この文を聞く」「元の音」で `t0`〜`t1` を鳴らす。

## 指摘（アプリ → Mac）: `指摘_<講のid>.json`

毎回、その講の指摘を**全部**書き出す（同じ名前で置き換える）。`fresh: true` は前回渡してから新しく入れた、または変えたもの。

```json
{
  "format": "tts-review/feedback", "version": 1, "exportedAt": "ISO",
  "chapter": { "id": "…", "title": "…", "audioId": "…", "passed": false },
  "settings": { "delay": 1 },
  "issues": [{
    "id": "…", "fresh": true, "stage": "sent|answered|done", "resolution": null,
    "unit": 31, "unitKey": "…", "unitText": "…", "unitRead": "…", "audioId": "指摘したときの版",
    "t0": 122.19, "at": 122.46,
    "kind": "読み|抑揚|間|語尾|崩れ|誤植|その他",
    "span": { "s": 12, "e": 14, "text": "徴候的" },
    "reading": "ちょうこうてき", "heard": "ちょうこてき",
    "pattern": "UUUUUU", "heardPattern": "U-DDUU",
    "gap": "長すぎる|短すぎる|間がほしい|切らないで",
    "note": "…",
    "allSame": false,
    "verdicts": [{ "alt": "代案のid", "verdict": "good|ok|close|reject|", "note": "…", "at": "ISO" }],
    "decision": { "choice": "代案のid|none", "instruction": "全部不採用のときの新しい指示", "at": "ISO" },
    "replies": ["受け取った返事のid"]
  }]
}
```

`verdicts` は案ごとの評価（◎良い・○可・△惜しい・×不可）とコメント。`decision` は指摘ごとの最終判断で、案を一つ選ぶ（`choice` が代案のid）か、`none`（全部不採用）で `instruction` に新しい指示を書く。判断がまだなら `null`。古い版のファイルには `verdict: "adopt"` が出ることがある（良い＋その案に決定、と読む）。

`allSame: true` は「この講の同じ語もまとめて直す」。まずその文で代案を決め、決まった直し方を講の中の同じ語（語の切れ目が合うもの）に当てて、`batch` の返事で返す。

`resolution`: `adopt:<代案のid>`（採用）、`closed`（本人が解決にした）、`fixed`（Macが反映済みと返した）。

## 返事（Mac → アプリ）: `返事_<講のid>_<日時>.json`

```json
{
  "format": "tts-review/reply", "version": 1, "chapter": "…", "created": "ISO",
  "items": [{
    "issue": "指摘のid", "id": "返事のid",
    "status": "alts|fixed|cannot|question|batch", "note": "Macからのひと言",
    "alts": [{ "id": "…", "label": "案1 ひらがな", "note": "…", "mime": "audio/mp4", "dur": 3.2,
               "data": "base64 の m4a",
               "unit": 70, "unitText": "…" }],          // batch のときだけ: その音がどの文か
    "skipped": [{ "unit": 62, "text": "…", "reason": "採用済みの直しがある" }]   // batch のときだけ
  }]
}
```

`fixed` を受け取った指摘は「済み」になる。それ以外は「返事あり」になり、本人の評価を待つ。

`batch` は一括の確認。`alts` の一つ一つが**別の文**（`unit`）の直した音で、アプリは「元（いまの講のその文）」と「新」を並べ、○（`good`）／×（`reject`）を付けてもらう。評価は普通の案と同じく `verdicts` で返る（○は講に入れる、×は引き直す、空はまだ）。`skipped` は当てなかった文とその理由（一覧に出すだけ）。採用済みの指摘に届いても「返事あり」に戻る。
