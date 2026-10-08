# 開発

コードを変えたら `make install` のあとに再ログインする。Wayland の GNOME Shell は動作中に拡張を読み直さない。

## テストは headless の GNOME Shell で画面まで確かめる

```sh
make test-unit             # gjs だけで動く。表示ロジック (src/model.js) と omp の呼び出し (src/store.js)
make test-shell            # headless の GNOME Shell に拡張を入れ、操作しながら画面を撮る
tests/shell/run.sh real    # 本物の omp で同じ確認をする
```

`make test-shell` は `dbus-run-session -- gnome-shell-test-tool --headless` で別セッションの GNOME Shell を起動するので、ログイン中のデスクトップには触れない。動作確認に使っているのは GNOME Shell 50.5。シナリオは 4 つある。

- `success`: 取得した内容がトップバーとドロップダウンに出る。トップバーに出ない枠の警告が、トップバーとスクロールしなくても見える位置の両方に出る。
- `fail-stale`: 取得に失敗しても前回の値を残す。
- `disable-midfetch`: omp が応答しない間に拡張を無効にすると、子プロセスが止まる。
- `prefs`: 設定画面を開き直しても、シェル側で変えた設定が保たれる。

`tests/shell/run.sh fail-stale prefs` のようにシナリオ名を渡すと、そのシナリオだけを実行する。ログとスクリーンショットは `tests/out/` に出る。

## omp の代わりに fake-omp を使う

`tests/fixtures/fake-omp` は `tests/fixtures/usage.json` の時刻を現在時刻にずらして返し、`omp config get auth.accountPolicies --json` には `tests/fixtures/config.json` を返す。次の環境変数で動きを変えられる。

| 環境変数 | 動き |
|---|---|
| `FAKE_OMP_MODE=fail` | 標準エラーにエラー文を書き、終了コード 1 を返す。標準出力は空。 |
| `FAKE_OMP_MODE=hang` | 応答しなくなる。 |
| `FAKE_OMP_POLICY_MODE=fail` | 設定の読み出しだけが失敗する。 |
| `FAKE_OMP_LOG=<path>` | 受け取った引数を 1 回 1 行で `<path>` に追記する。 |

## D-Bus の起動待ちで落ちたら再実行する

シナリオが `oh-my-usage test:` の行を 1 つも出さずに失敗し、ログに `Failed to activate service 'org.freedesktop.secrets': timed out` があれば、テスト用 D-Bus セッションの起動待ちで時間切れになっている。拡張の不具合ではないので、そのシナリオだけ再実行する。
