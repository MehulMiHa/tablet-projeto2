'use strict';

// Numeric meanings checked against the installed python-roborock 6.2.1 enums:
// https://github.com/Python-roborock/python-roborock/blob/df75659f4ee87d1c04f241bc0b1fa7b6d1f70715/roborock/data/v1/v1_code_mappings.py
// Codes outside these tables remain visible, without guessing their meaning.
const ROBOT_ERRORS = {
  1: ['Sensor laser bloqueado', 'Remove obstáculos à volta da torre laser e verifica se consegue rodar.'],
  2: ['Para-choques preso', 'Remove o obstáculo e verifica se o para-choques se move livremente.'],
  3: ['Rodas sem contacto com o chão', 'Coloca o Rocky numa superfície plana, com as rodas apoiadas.'],
  4: ['Verificar sensores de desnível', 'Limpa os sensores de desnível e coloca o Rocky numa superfície plana.'],
  5: ['Escova principal bloqueada', 'Retira cabelos e objetos da escova principal e volta a instalá-la.'],
  6: ['Escova lateral bloqueada', 'Retira cabelos e objetos da escova lateral.'],
  7: ['Rodas bloqueadas', 'Remove objetos presos nas rodas e verifica se rodam livremente.'],
  8: ['Rocky preso', 'Liberta o Rocky e remove os obstáculos à sua volta.'],
  9: ['Depósito do pó em falta', 'Instala corretamente o depósito do pó e o filtro.'],
  10: ['Filtro molhado ou bloqueado', 'Limpa o filtro e deixa-o secar completamente antes de o voltar a instalar.'],
  11: ['Campo magnético detetado', 'Afasta o Rocky de objetos magnéticos e volta a tentar.'],
  12: ['Bateria fraca', 'Coloca o Rocky na base para carregar.'],
  13: ['Falha de carregamento', 'Limpa os contactos de carga e verifica a alimentação da base.'],
  14: ['Erro de bateria', 'Consulta o aviso de bateria na app Roborock; se persistir, contacta o suporte.'],
  15: ['Sensor de parede sujo', 'Limpa o sensor de parede na lateral do Rocky.'],
  16: ['Rocky inclinado', 'Coloca o Rocky numa superfície plana.'],
  17: ['Erro na escova lateral', 'Verifica se a escova lateral está corretamente instalada e livre de objetos.'],
  18: ['Erro no ventilador', 'Consulta o aviso do ventilador na app Roborock; se persistir, contacta o suporte.'],
  19: ['Base sem alimentação', 'Verifica o cabo e a tomada de alimentação da base.'],
  20: ['Sensor de movimento sujo', 'Limpa o sensor de movimento na parte inferior do Rocky.'],
  21: ['Para-choques superior pressionado', 'Remove objetos sobre o Rocky e verifica se o para-choques superior está livre.'],
  22: ['Erro ao localizar a base', 'Limpa os sensores de localização e mantém o acesso à base desimpedido.'],
  23: ['Não conseguiu regressar à base', 'Desimpede o percurso até à base e verifica a sua alimentação.'],
  24: ['Rocky numa zona proibida', 'Move o Rocky para fora da zona proibida antes de continuar.'],
  25: ['Erro no sensor visual', 'Limpa a câmara e consulta o aviso na app Roborock.'],
  26: ['Erro no sensor de parede', 'Limpa o sensor de parede e remove obstáculos junto à lateral do Rocky.'],
  27: ['Sistema de mopa bloqueado', 'Verifica se há objetos presos no suporte da mopa.'],
  28: ['Rocky sobre um tapete', 'Move o Rocky para um chão sem tapete para continuar a lavagem.'],
  29: ['Filtro bloqueado', 'Limpa o filtro e o depósito do pó e volta a instalá-los.'],
  30: ['Parede virtual detetada', 'Move o Rocky para fora da área limitada pela parede virtual.'],
  31: ['Não consegue atravessar o tapete', 'Remove o obstáculo ou escolhe um percurso sem esse tapete.'],
  32: ['Erro interno do Rocky', 'Consulta o aviso na app Roborock; se persistir, contacta o suporte.'],
  34: ['Esvaziamento do pó bloqueado', 'Limpa o depósito, o filtro e a conduta de esvaziamento da base.'],
  35: ['Erro elétrico no esvaziamento', 'Verifica a alimentação da base e consulta o aviso na app Roborock.'],
  36: ['Rolo de lavagem bloqueado', 'Remove objetos presos no rolo de lavagem da base.'],
  37: ['Rolo de lavagem fora de posição', 'Verifica se o rolo de lavagem está corretamente colocado.'],
  38: ['Verificar depósito de água limpa', 'Verifica a colocação do depósito de água limpa na base.'],
  39: ['Verificar depósito de água suja', 'Esvazia e volta a colocar o depósito de água suja na base.'],
  40: ['Filtro de água fora de posição', 'Volta a instalar corretamente o filtro de água da base.'],
  41: ['Encher depósito de água limpa', 'Enche e volta a colocar o depósito de água limpa na base.'],
  42: ['Verificar filtro de água', 'Verifica se o filtro de água da base está corretamente instalado.'],
  43: ['Erro no botão de posicionamento', 'Consulta o aviso na app Roborock para verificar o botão de posicionamento.'],
  44: ['Limpar filtro de água', 'Limpa e volta a instalar o filtro de água da base.'],
  45: ['Rolo de lavagem bloqueado', 'Remove objetos presos no rolo de lavagem da base.'],
  48: ['Erro no abastecimento de água', 'Verifica o depósito de água limpa e consulta o aviso de abastecimento na app Roborock.'],
  49: ['Erro na drenagem de água', 'Verifica o depósito de água suja e consulta o aviso de drenagem na app Roborock.'],
  51: ['Proteção de temperatura ativa', 'Deixa o equipamento arrefecer e consulta o aviso na app Roborock.'],
  53: ['Bandeja de lavagem cheia', 'Verifica e limpa a bandeja de lavagem e o respetivo filtro.'],
  54: ['Suporte da mopa solto', 'Verifica se o suporte da mopa está corretamente instalado.']
};

const DOCK_ERRORS = {
  32: ['Depósito ou filtro da base em falta', 'Instala corretamente o depósito do pó e o filtro da base.'],
  33: ['Erro no ventilador da base', 'Verifica se o depósito do pó e o filtro da base estão bem colocados.'],
  34: ['Conduta de esvaziamento bloqueada', 'Limpa o depósito, o filtro e a conduta de esvaziamento da base.'],
  35: ['Erro elétrico na base', 'Verifica a alimentação da base e consulta o aviso na app Roborock.'],
  38: ['Encher depósito de água limpa', 'Enche e volta a colocar o depósito de água limpa na base.'],
  39: ['Esvaziar depósito de água suja', 'Esvazia o depósito de água suja e volta a colocá-lo corretamente na base.'],
  42: ['Escova de manutenção bloqueada', 'Retira e limpa a escova de manutenção da base.'],
  44: ['Filtro de água bloqueado', 'Limpa e reinstala o filtro; fecha a tampa do depósito de água suja e prende o fecho.'],
  46: ['Depósito do pó em falta na base', 'Instala corretamente o depósito do pó da base.'],
  53: ['Bandeja de lavagem cheia ou bloqueada', 'Limpa a bandeja e o filtro de água e verifica se estão corretamente instalados.']
};

function errorAlert(code, source) {
  const known = (source === 'dock' ? DOCK_ERRORS : ROBOT_ERRORS)[code];
  return {
    id: source === 'dock' && code === 38 ? 'clean-water-empty' : `${source}-error-${code}`,
    severity: source === 'dock' ? 'warning' : 'error',
    title: known ? known[0] : source === 'dock' ? `Aviso ${code} na base` : `Erro ${code} no Rocky`,
    detail: known ? known[1] : `Código ${code} ainda não identificado. Consulta o aviso na app Roborock.`,
    code, source
  };
}

module.exports = { errorAlert };
