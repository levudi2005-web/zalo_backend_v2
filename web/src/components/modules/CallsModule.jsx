import { ModuleEmptyState, ModuleScaffold } from './ModuleScaffold'

export function CallsModule() {
  return (
    <ModuleScaffold icon="◉" title="Cuộc gọi" description="Quản lý các cuộc gọi thoại và video.">
      <div className="module-planned-grid">
        <div className="module-planned-panel"><strong>Cuộc gọi đến</strong><span>Chưa có cuộc gọi đến.</span></div>
        <div className="module-planned-panel"><strong>Cuộc gọi đi</strong><span>Chưa có lịch sử cuộc gọi.</span></div>
        <div className="module-planned-panel"><strong>Điều khiển cuộc gọi</strong><span>Voice, video, camera và speaker sẽ được kết nối sau.</span></div>
      </div>
      <ModuleEmptyState icon="◉" title="Chưa có cuộc gọi">Tính năng gọi đang ở trạng thái scaffold.</ModuleEmptyState>
    </ModuleScaffold>
  )
}
