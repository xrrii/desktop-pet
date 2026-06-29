import './styles.css'
import { PetAnimator, loadImage } from './pet/animation'
import { attachDragController } from './pet/drag'
import { loadPetManifest, getSpritesheetUrl, type PetStateName } from './pet/petManifest'
import { PetStateMachine } from './pet/stateMachine'

const canvas = document.querySelector<HTMLCanvasElement>('#pet-canvas')
const root = document.querySelector<HTMLElement>('#pet-root')
const errorPanel = document.querySelector<HTMLElement>('#pet-error')

if (!canvas || !root || !errorPanel) {
  throw new Error('Renderer DOM is incomplete.')
}

void bootstrap()

async function bootstrap(): Promise<void> {
  try {
    const settings = await window.desktopPet.getSettings()
    const stateMachine = new PetStateMachine()
    const scale = settings.scale > 0 ? settings.scale : 1
    let animator: PetAnimator | null = null

    const loadPet = async (petId: string): Promise<void> => {
      const manifest = await loadPetManifest(petId)
      const image = await loadImage(getSpritesheetUrl(manifest))
      root.style.width = `${Math.round(manifest.atlas.cellWidth * scale)}px`
      root.style.height = `${Math.round(manifest.atlas.cellHeight * scale)}px`
      errorPanel.hidden = true

      animator?.stop()
      animator = new PetAnimator({
        canvas,
        manifest,
        spritesheet: image,
        scale,
        onLoopComplete: () => {
          animator?.setState(stateMachine.completeLoop())
        }
      })
      animator.start()
    }

    const play = (state: PetStateName): void => {
      if (animator) {
        animator.setState(stateMachine.play(state))
      }
    }

    attachDragController({
      target: root,
      onDragMove: (dx) => stateMachine.setDraggingState(dx),
      onDragEnd: () => stateMachine.stopDragging(),
      onStateChange: (state) => animator?.setState(state),
      onClick: () => play('waving'),
      onDoubleClick: () => play('jumping'),
      onContextMenu: () => {
        void window.desktopPet.showContextMenu()
      }
    })

    window.desktopPet.onSetAction((action) => {
      play(action)
    })

    window.desktopPet.onSwitchPet((petId) => {
      void loadPet(petId).catch(showError)
    })

    await loadPet(settings.petId)
  } catch (error) {
    showError(error)
  }
}

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  errorPanel.hidden = false
  errorPanel.textContent = `Desktop pet failed to load: ${message}`
}
