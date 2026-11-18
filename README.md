# Eddy

Painel Android para o tablet da sala. O APK inclui a interface e liga-se ao servidor Eddy em `http://127.0.0.1:3000`. O servidor comunica com a Bridge Hue, a Sync Box e o Saros 10R. Durante uma interrupção, guarda os últimos estados confirmados. Sem presença, o ecrã fica completamente preto.

## Compilar o APK

Abre a pasta `android` no Android Studio ou corre `gradlew.bat :app:assembleDebug` nessa pasta com o JDK do Android Studio. O Gradle inclui `index.html` e `assets/` no APK. Para atualizar uma instalação anterior, usa a mesma chave de assinatura.

## Servidor no tablet

1. No Termux, prepara Node.js 20 ou superior, PM2, `curl`, `flock` e Python com `python-roborock` 6.2.1. O worker usa a sessão Roborock guardada pelo comando `roborock login` no próprio tablet.
2. Copia `server/`, `index.html` e `assets/` para `~/eddy/`. Copia `server/config.example.json` para `~/eddy/server/config.local.json` e preenche os dados dos teus aparelhos. Guarda esse ficheiro no tablet com permissões `600`.
3. Instala e abre uma vez o Termux:Boot. Copia `server/start-eddy.sh` para `~/.termux/boot/start-eddy.sh` e dá-lhe permissões `700`. Se houver um servidor anterior a ocupar a porta 3000, para-o e desativa o respetivo script de arranque antes de iniciar o Eddy.
4. Executa `~/.termux/boot/start-eddy.sh` e confirma com `curl http://127.0.0.1:3000/api/health`. Para consultar os registos, usa `PM2_HOME="$HOME/.pm2-eddy" pm2 logs eddy-server`.
5. Para permitir que a app recupere o servidor se este ficar indisponível, define `allow-external-apps = true` em `~/.termux/termux.properties`, recarrega as definições do Termux e concede à app Eddy a permissão **Executar comandos no Termux**. Define Eddy como app de início nas definições do Android para abrir o painel depois do arranque.

O Termux:Boot inicia o servidor após o arranque do Android, assim que o armazenamento do utilizador estiver disponível. O PM2 reinicia o processo se ele terminar. A app verifica a disponibilidade do serviço local. Uma falha de ligação a um aparelho é apresentada no painel.

## Verificar as alterações

```sh
cd server
node --test *.test.js
python3 robot_protocol_test.py
python3 robot_worker_test.py
```

Os testes do servidor não enviam ordens à casa. No tablet, confirma o mapa e os estados reais. Depois de configurar o arranque automático, reinicia o Android e confirma que o painel está aberto e o endpoint `/api/health` responde.

## Interface 2.3

O Rocky abre na escolha de divisões ou de uma área no mapa. A seleção guarda separadamente as divisões a aspirar e a lavar. As opções de potência e água ficam em «Ajustes».

Enquanto o Rocky trabalha, o relógio mostra a tarefa, localização confirmada, avisos e comandos contextuais. Durante uma falha de ligação, mantém a última leitura identificada como antiga e desativa os comandos. Um aviso de água limpa, quando está parado na base, fica compacto no relógio. Quando o sensor confirma ausência, desaparece toda a interface, incluindo avisos, controlos e notificações. O primeiro toque acorda apenas o relógio. Uma falha de energia mantém a luz e voz de emergência disponíveis.

A passagem entre Sala e Rocky usa duas páginas que deslizam horizontalmente, tanto pelos separadores como pelo gesto de arrastar. A transição das letras fica reservada ao relógio. Os gestos não interferem com os sliders, a seleção de luzes ou o desenho de uma área no mapa.

A voz de emergência usa uma voz portuguesa offline quando instalada e o volume de alarme configurado no Android. As mensagens aguardam a inicialização do motor de voz; a reposição da energia cancela avisos ainda pendentes. A app respeita o volume e o modo Não incomodar.

A localização atual usa o segmento reportado pelo aspirador; o destino da ordem é guardado separadamente. Quando esse segmento não está disponível, o painel pode usar o segmento do mapa real, com a hora da leitura. Sem dados suficientes, mostra que a localização está por confirmar.
