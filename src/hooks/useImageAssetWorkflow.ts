import { useEffect, useRef, useState } from 'react'
import {
  applyReferenceAppearanceAnalysis,
  confirmCharacterPortrait,
  createCharacterDraft,
  restoreIllustrationsBlockedByReference,
  setCharacterPortraitFailed,
  setCharacterPortraitGenerating,
  setCharacterPortraitReady,
  setIllustrationBlockedByReference,
  setIllustrationFailed,
  setIllustrationGenerating,
  setIllustrationReady,
  updateCharacterProfile,
  updateCharacterReferenceStyleMode,
} from '../data/storyDatabase'
import { resolveIllustrationReferences } from '../domain/illustrationReferences'
import { resolvePreviousSceneIllustration } from '../domain/sceneContinuity'
import { resolveIllustrationMode, type CharacterAsset, type IllustrationAsset, type IllustrationMode, type ProjectWorkspace, type ReferenceStyleMode, type WritingTurnResult } from '../domain/models'
import type { ReferenceImageTarget } from '../domain/referenceImage'
import { persistImageAsset, resolveImageSource } from '../providers/imageAssetStore'
import { browserTransport } from '../providers/browserTransport'
import { logImagePipeline } from '../providers/imagePipelineLog'
import { buildIllustrationPrompt } from '../providers/illustrationPrompt'
import { buildCharacterPortraitPrompt, editOpenAiImage, generateOpenAiImage, resolveImageSize } from '../providers/images'
import { analyzeReferenceImage } from '../providers/referenceAnalysis'
import { secretStore } from '../providers/secretStore'
import type { ProviderSettings, ProviderSlot } from '../providers/types'
import { useImageTaskQueue } from './useImageTaskQueue'

type ToastKind = 'success' | 'error'
type IllustrationGenerationStage = 'waiting' | 'downloading' | 'saving' | 'validating'

interface UseImageAssetWorkflowOptions {
  workspace: ProjectWorkspace | null
  providerSettings: ProviderSettings
  refreshWorkspace: (projectId: string) => Promise<ProjectWorkspace | null | undefined>
  showToast: (text: string, kind?: ToastKind) => void
  openProviderSettings: (slot: ProviderSlot) => void
  onRequireImageProviderForCharacter: () => void
  onOpenCharacterAssets: () => void
  onReferenceImported: () => void
  onCharacterCreated: () => void
}

export function useImageAssetWorkflow({
  workspace,
  providerSettings,
  refreshWorkspace,
  showToast,
  openProviderSettings,
  onRequireImageProviderForCharacter,
  onOpenCharacterAssets,
  onReferenceImported,
  onCharacterCreated,
}: UseImageAssetWorkflowOptions) {
  const { enqueueImageTask, enqueueOnce } = useImageTaskQueue()
  const portraitGenerationCancelledRef = useRef(false)
  const [portraitGenerationActive, setPortraitGenerationActive] = useState(false)
  const [imageProviderReady, setImageProviderReady] = useState(false)
  const [illustrationGenerationStages, setIllustrationGenerationStages] = useState<Record<string, IllustrationGenerationStage>>({})

  async function providerIsReady(slot: ProviderSlot) {
    const provider = providerSettings[slot]
    return Boolean(provider.baseUrl.trim() && provider.model.trim() && await secretStore.has(provider.secretRef))
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const ready = await providerIsReady('image')
      if (!cancelled) setImageProviderReady(ready)
    })()
    return () => { cancelled = true }
  }, [providerSettings.image])

  function cancelPortraitGeneration() {
    portraitGenerationCancelledRef.current = true
    showToast('已停止后续定妆照生成；当前请求结束后不会继续排队')
  }

  async function generateCharacterPortrait(character: CharacterAsset, sourceWorkspace: ProjectWorkspace, feedback?: string) {
    await setCharacterPortraitGenerating(character.id)
    await refreshWorkspace(sourceWorkspace.project.id)
    try {
      const prompt = buildCharacterPortraitPrompt(character, sourceWorkspace.style, feedback)
      const currentReference = resolveImageSource(character.continuity.referenceImageUrl, character.continuity.localUri)
      const nativeTarget = { projectId: sourceWorkspace.project.id, assetId: character.id, target: 'portrait' as const }
      const imageUrl = feedback && currentReference
        ? await editOpenAiImage(providerSettings.image, prompt, [currentReference], browserTransport, resolveImageSize(providerSettings.image, 'portrait', '1024x1536'), undefined, nativeTarget)
        : await generateOpenAiImage(providerSettings.image, prompt, browserTransport, resolveImageSize(providerSettings.image, 'portrait', '1024x1536'), undefined, nativeTarget)
      const storedImage = await persistImageAsset(imageUrl, sourceWorkspace.project.id, character.id)
      await setCharacterPortraitReady(character.id, storedImage.imageUrl, storedImage.localUri)
      await refreshWorkspace(sourceWorkspace.project.id)
      showToast(`${character.name}的定妆照已生成；去角色资产确认后，相关插画会自动继续`)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      await setCharacterPortraitFailed(character.id, message)
      await refreshWorkspace(sourceWorkspace.project.id)
      showToast(`${character.name}的定妆照生成失败`, 'error')
      return false
    }
  }

  async function requestCharacterPortrait(characterId: string, feedback?: string) {
    if (!workspace) return
    const character = workspace.characters.find((item) => item.id === characterId)
    if (!character) return
    if (!(await providerIsReady('image'))) {
      onRequireImageProviderForCharacter()
      openProviderSettings('image')
      showToast('请先完成图片模型配置')
      return
    }
    const succeeded = await enqueueImageTask(() => generateCharacterPortrait(character, workspace, feedback))
    if (!succeeded) throw new Error('定妆照生成失败')
  }

  async function importCharacterReference(target: ReferenceImageTarget, dataUrl: string, referenceStyleMode: ReferenceStyleMode, autoAnalyze: boolean) {
    if (!workspace) return
    try {
      const characterId = 'characterId' in target
        ? target.characterId
        : (await createCharacterDraft(workspace.project.id, target.name, target.role)).id
      const storedImage = await persistImageAsset(dataUrl, workspace.project.id, characterId, 'imported')
      await setCharacterPortraitReady(characterId, storedImage.imageUrl, storedImage.localUri, referenceStyleMode)
      let analysisMessage = ''
      if (autoAnalyze) {
        if (await providerIsReady('text')) {
          try {
            const analysis = await analyzeReferenceImage(dataUrl, providerSettings.text, browserTransport)
            await applyReferenceAppearanceAnalysis(characterId, analysis)
            analysisMessage = '，外貌档案已识别，请核对后确认'
          } catch (analysisError) {
            analysisMessage = '；图片已保存，但外貌识别失败，可在角色资产中手动填写或重新识别'
            console.warn('Reference image analysis failed', analysisError instanceof Error ? analysisError.message : String(analysisError))
          }
        } else {
          analysisMessage = '；图片已保存，配置可识图的文本模型后可在角色资产中识别外貌'
        }
      }
      await refreshWorkspace(workspace.project.id)
      onReferenceImported()
      showToast(`参考图已导入${analysisMessage || '，请补充档案后确认'}`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : '参考图导入失败', 'error')
    }
  }

  async function handleReferenceStyleModeChange(characterId: string, referenceStyleMode: ReferenceStyleMode) {
    if (!workspace) return
    await updateCharacterReferenceStyleMode(characterId, referenceStyleMode)
    await refreshWorkspace(workspace.project.id)
    showToast(referenceStyleMode === 'project' ? '该角色会统一为作品画风' : '该角色会保留参考图画风')
  }

  async function handleUpdateCharacterProfile(characterId: string, profile: { narrativePronoun?: CharacterAsset['narrativePronoun']; ageAndBuild: string; fixedTraits: string[]; defaultLook: string; wardrobe: string }) {
    if (!workspace) return
    try {
      await updateCharacterProfile(characterId, profile)
      await refreshWorkspace(workspace.project.id)
      showToast('角色档案已更新')
    } catch (error) {
      showToast(error instanceof Error ? error.message : '角色档案保存失败', 'error')
    }
  }

  async function handleAnalyzeReference(characterId: string) {
    if (!workspace) return
    const character = workspace.characters.find((item) => item.id === characterId)
    const referenceSource = character
      ? resolveImageSource(character.continuity.referenceImageUrl, character.continuity.localUri)
      : undefined
    if (!referenceSource) throw new Error('这张参考图无法作为识别输入，请重新导入原图后重试')
    if (!(await providerIsReady('text'))) {
      openProviderSettings('text')
      throw new Error('请先配置可识图的文本模型')
    }
    try {
      const analysis = await analyzeReferenceImage(referenceSource, providerSettings.text, browserTransport)
      await applyReferenceAppearanceAnalysis(characterId, analysis)
      await refreshWorkspace(workspace.project.id)
      showToast('外貌档案已重新识别，请核对并再次确认')
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : '外貌识别失败，请手动补充档案')
    }
  }

  async function generateIllustration(illustration: IllustrationAsset, sourceWorkspace: ProjectWorkspace) {
    const referenceResolution = resolveIllustrationReferences(illustration, sourceWorkspace.characters)
    if (!referenceResolution.ready) {
      await setIllustrationBlockedByReference(illustration.id, referenceResolution.reason)
      await refreshWorkspace(sourceWorkspace.project.id)
      showToast(referenceResolution.reason, 'error')
      return
    }
    await setIllustrationGenerating(illustration.id)
    setIllustrationGenerationStages((current) => ({ ...current, [illustration.id]: 'waiting' }))
    await refreshWorkspace(sourceWorkspace.project.id)
    const pipelineStartedAt = Date.now()
    try {
      const referenceCharacters = referenceResolution.characters
      const characterReferenceSources = referenceCharacters
        .map((character) => resolveImageSource(character.continuity.referenceImageUrl, character.continuity.localUri) as string)
      const previousSceneIllustration = resolvePreviousSceneIllustration(illustration, sourceWorkspace.illustrations)
      const sceneReferenceSource = previousSceneIllustration
        ? resolveImageSource(previousSceneIllustration.imageUrl, previousSceneIllustration.localUri)
        : undefined
      const referenceSources = sceneReferenceSource
        ? [...characterReferenceSources, sceneReferenceSource]
        : characterReferenceSources
      const prompt = buildIllustrationPrompt(illustration, sourceWorkspace.style, referenceCharacters, Boolean(sceneReferenceSource))
      const nativeTarget = { projectId: sourceWorkspace.project.id, assetId: illustration.id, target: 'illustration' as const }
      const setStage = (stage: IllustrationGenerationStage) => {
        setIllustrationGenerationStages((current) => ({ ...current, [illustration.id]: stage }))
      }
      const imageUrl = referenceSources.length
        ? await editOpenAiImage(providerSettings.image, prompt, referenceSources, browserTransport, resolveImageSize(providerSettings.image, 'landscape', '1536x1024'), setStage, nativeTarget)
        : await generateOpenAiImage(providerSettings.image, prompt, browserTransport, resolveImageSize(providerSettings.image, 'landscape', '1536x1024'), setStage, nativeTarget)
      const storedImage = await persistImageAsset(imageUrl, sourceWorkspace.project.id, illustration.id, 'generated', setStage)
      await setIllustrationReady(illustration.id, storedImage.imageUrl, storedImage.localUri)
      await refreshWorkspace(sourceWorkspace.project.id)
      logImagePipeline('info', {
        phase: 'illustration-complete',
        illustrationId: illustration.id,
        usesReferences: referenceResolution.usesReferences,
        durationMs: Date.now() - pipelineStartedAt,
      })
      showToast('剧情插画已生成')
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      logImagePipeline('warn', {
        phase: 'illustration-failed',
        illustrationId: illustration.id,
        usesReferences: referenceResolution.usesReferences,
        durationMs: Date.now() - pipelineStartedAt,
        message,
      })
      await setIllustrationFailed(illustration.id, message)
      await refreshWorkspace(sourceWorkspace.project.id)
      showToast('剧情插画生成失败，没有自动重试', 'error')
    } finally {
      setIllustrationGenerationStages((current) => {
        const { [illustration.id]: _finished, ...remaining } = current
        return remaining
      })
    }
  }

  function queueIllustration(illustration: IllustrationAsset, sourceWorkspace: ProjectWorkspace) {
    return enqueueOnce(illustration.id, () => generateIllustration(illustration, sourceWorkspace))
  }

  async function confirmCharacter(characterId: string) {
    if (!workspace) return
    const legacyReferenceBlocks = workspace.illustrations.flatMap((illustration) => {
      if (illustration.status !== 'failed' || illustration.failureKind || !illustration.errorMessage) return []
      const resolution = resolveIllustrationReferences(illustration, workspace.characters)
      return !resolution.ready && illustration.errorMessage === resolution.reason
        ? [{ illustrationId: illustration.id, reason: resolution.reason }]
        : []
    })
    try {
      await confirmCharacterPortrait(characterId)
    } catch (error) {
      showToast(error instanceof Error ? error.message : '确认角色失败', 'error')
      return
    }
    await Promise.all(legacyReferenceBlocks.map(({ illustrationId, reason }) => (
      setIllustrationBlockedByReference(illustrationId, reason)
    )))
    let nextWorkspace = await refreshWorkspace(workspace.project.id)
    if (!nextWorkspace) return
    const confirmedWorkspace = nextWorkspace
    const readyReferenceBlocks = confirmedWorkspace.illustrations.filter((illustration) => {
      if (illustration.failureKind !== 'reference-unavailable') return false
      const resolution = resolveIllustrationReferences(illustration, confirmedWorkspace.characters)
      return resolution.ready && resolution.characters.some((character) => character.id === characterId)
    })
    if (readyReferenceBlocks.length) {
      await restoreIllustrationsBlockedByReference(confirmedWorkspace.project.id, readyReferenceBlocks.map((illustration) => illustration.id))
      nextWorkspace = await refreshWorkspace(workspace.project.id)
      if (!nextWorkspace) return
      showToast(`已解锁 ${readyReferenceBlocks.length} 张等待中的插画，自动配图开启时会继续生成`)
    }
    if (resolveIllustrationMode(nextWorkspace.project) !== 'auto' || !(await providerIsReady('image'))) return
    const eligible = nextWorkspace.illustrations.filter((illustration) => {
      if (illustration.status !== 'planned' || illustration.generationMode === 'manual') return false
      const resolution = resolveIllustrationReferences(illustration, nextWorkspace.characters)
      return resolution.ready && resolution.characters.some((character) => character.id === characterId)
    })
    for (const illustration of eligible) void queueIllustration(illustration, nextWorkspace)
  }

  async function createCharacterWithoutReference(target: { name: string; role: string }) {
    if (!workspace) return
    await createCharacterDraft(workspace.project.id, target.name, target.role)
    await refreshWorkspace(workspace.project.id)
    onCharacterCreated()
    showToast('角色已创建，可在角色资产中生成定妆照')
  }

  async function retryIllustration(illustrationId: string) {
    if (!workspace || !(await providerIsReady('image'))) {
      openProviderSettings('image')
      showToast('请先完成图片模型配置')
      return
    }
    const illustration = workspace.illustrations.find((item) => item.id === illustrationId)
    if (!illustration) return
    if (illustration.status === 'generating') {
      onOpenCharacterAssets()
      return
    }
    await queueIllustration(illustration, workspace)
  }

  async function handleWritingCompleted({
    result,
    nextWorkspace,
    previousIllustrationIds,
    illustrationMode,
  }: {
    result: WritingTurnResult
    nextWorkspace: ProjectWorkspace
    previousIllustrationIds: ReadonlySet<string>
    illustrationMode: IllustrationMode
  }) {
    if (result.kind !== 'prose' || !result.visualPlan) {
      if (result.kind === 'prose') showToast('正文已保存')
      return
    }
    const newCharacterNames = new Set(result.visualPlan.characters.map((character) => character.name.toLocaleLowerCase()))
    const portraits = nextWorkspace.characters.filter((character) => (
      newCharacterNames.has(character.name.toLocaleLowerCase()) && (character.portraitStatus ?? 'planned') === 'planned'
    ))
    const newIllustrations = nextWorkspace.illustrations.filter((illustration) => !previousIllustrationIds.has(illustration.id))
    const imageReady = await providerIsReady('image')
    const readyIllustrations = newIllustrations.filter((illustration) => (
      illustration.status === 'planned' && illustration.generationMode !== 'manual' && resolveIllustrationReferences(illustration, nextWorkspace.characters).ready
    ))
    if (illustrationMode === 'auto' && portraits.length && imageReady) {
      portraitGenerationCancelledRef.current = false
      setPortraitGenerationActive(true)
      void enqueueImageTask(async () => {
        try {
          for (const character of portraits) {
            if (portraitGenerationCancelledRef.current) break
            await generateCharacterPortrait(character, nextWorkspace)
          }
        } finally {
          setPortraitGenerationActive(false)
        }
      })
      showToast('正文已保存，定妆照已进入生成队列')
    } else if (illustrationMode === 'manual') {
      showToast('正文和视觉计划已保存；可选择需要的插画手动生成')
    } else if (illustrationMode === 'none') {
      showToast('正文已保存')
    } else if (!imageReady) {
      showToast('正文和视觉计划已保存；请先配置图片模型')
    } else if (readyIllustrations.length) {
      for (const illustration of readyIllustrations) void queueIllustration(illustration, nextWorkspace)
      showToast('正文已保存，插画已进入生成队列')
    } else {
      showToast(newIllustrations.length ? '正文和视觉计划已保存；请先确认角色定妆照' : '正文和视觉计划已保存')
    }
  }

  return {
    cancelPortraitGeneration,
    confirmCharacter,
    createCharacterWithoutReference,
    handleAnalyzeReference,
    handleReferenceStyleModeChange,
    handleUpdateCharacterProfile,
    handleWritingCompleted,
    illustrationGenerationStages,
    imageProviderReady,
    importCharacterReference,
    portraitGenerationActive,
    requestCharacterPortrait,
    retryIllustration,
  }
}
