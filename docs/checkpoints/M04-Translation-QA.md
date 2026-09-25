---
tags: [checkpoint, translation, qa]
status: open
updated: 2026-09-25
---

# M04 — Translation QA pack (first pass)

_Task M04.7: sample translations reviewed for meaning. Requirement F4.2 asks for the **project owner's** rating; this page records the first development review so the owner can confirm or correct it._

**Setup:** Qwen3-4B-Instruct-2507 Q4_K_M ([ADR-0019](../architecture/decisions/0019-translator-qwen3-4b.md)), llama.cpp b11174 fully on the Quadro T1000, prompt v1 ([Spec 07 §2.2](../specification/07-ASR-And-Translation.md#22-prompt-v1-as-built)). Source: whisper-small transcript of Kafka, _Die Verwandlung_ ch. 1 (LibriVox, public domain). Dense literary prose, much harder than dialogue.

## Samples

| German source                                                                                       | English                                                                                     | French                                                                                                      | Arabic                                                                           |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| „Was ist mit mir geschehen?" dachte er.                                                             | —                                                                                           | « Qu'est-ce qui m'est arrivé ? » pensa-t-il. ✅                                                             | "ما الذي حدث لي؟" تساءل. ✅                                                      |
| Es war kein Traum.                                                                                  | —                                                                                           | Ce n'était pas un rêve. ✅                                                                                  | لم يكن حلمًا. ✅                                                                 |
| Samsa eines Morgens aus unruhigen Träumen erwachte,                                                 | Samsa awoke one morning from restless dreams, ✅                                            | —                                                                                                           | —                                                                                |
| fand er sich in seinem Bett zu einem ungeheuren Ungeziefer verwandelt.                              | to find himself transformed into an enormous insect. ⚠️ drops "in his bed"                  | et se trouva transformé en une créature énorme et bestiale. ⚠️ "vermin" softened                            | ووجد نفسه مُحوّلًا إلى كائن ضخم من الحشرات. ✅                                   |
| Er lag auf / seinem panzerartig harten Rücken und sah, wenn er den Kopf ein wenig hob, …            | He lay on / his hard, exoskeleton-like back and saw, when he lifted his head slightly, … ✅ | Il se trouvait allongé sur / son dos dur et écaille, et vit, en levant légèrement la tête, … ✅             | كان يُلقي على / ظهره الصلب … ورأى عند رفع رأسه بضع مُحَدَّثات بُنية … ❌ garbled |
| … auf dessen Höhe sich die Bettdecke zum gänzlichen Niedergleiten bereit kaum noch erhalten konnte. | whose height the bedsheet could barely retain as it sagged completely. ⚠️ awkward           | … la couverture commençait à tomber complètement. ✅                                                        | … حيث تَنخفض سُرعة الريش إلى الحد الأقصى. ❌ "speed of the feathers"             |
| Seine vielen … kläglich dünnen Beine flimmerten ihm hilflos vor den Augen.                          | His many thin legs … flickered helplessly before him / his eyes. ✅                         | Ses nombreux jambes … lui paraissaient inutiles / devant les yeux. ⚠️ grammar ("nombreuses"), meaning drift | أطرافه … كانت ضعيفة جدًا وظهرت أمام عينيه بعجز / في عينيه. ✅                    |

## First-pass assessment

| Pair    | Lines checked | Meaning preserved | Notes                                                            |
| ------- | ------------- | ----------------- | ---------------------------------------------------------------- |
| de → en | 14            | ~12/14            | Fluent; one omission, one awkward clause                         |
| de → fr | 16            | ~13/16            | Fluent; occasional gender agreement slips, some paraphrase       |
| de → ar | 16            | ~10/16            | Short/dialogue lines good; long descriptive sentences break down |

Structure held everywhere: every run mapped 1:1 onto the source cues (0 low-confidence cues in 10 min of de → en after the fragment fixes; 1 in a 4-min de → fr run from the player).

**Against AC3 (> 90 % meaning-preserving):** met for simple and dialogue lines; **not met** for dense literary German into French/Arabic with this 4B model. Options to raise it, for the owner to decide: accept (dialogue is the main use case), offer a larger Apache-2.0 model as an opt-in "quality" choice (e.g. Qwen3-8B, which needs partial CPU offload and runs ~3× slower), or tune the prompt per language.

## To do (owner)

- [ ] Rate these samples and a dialogue-heavy clip (film/interview) per language pair.
- [ ] Decide on an optional larger translation model.
