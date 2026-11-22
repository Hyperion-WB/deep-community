// 游戏配置
const DIFFICULTY_SETTINGS = {
    beginner: { rows: 10, cols: 10, mines: 10 },
    intermediate: { rows: 16, cols: 16, mines: 40 },
    expert: { rows: 16, cols: 30, mines: 99 },
    intermediate_phone: { rows: 26, cols: 10, mines: 40 },
    expert_phone: { rows: 48, cols: 10, mines: 99 }
};

// 游戏状态
class MinesweeperGame {
    constructor() {
        // DOM 元素
        this.gameBoard = document.getElementById('gameBoard');
        this.mineCountDisplay = document.getElementById('mineCount');
        this.timerDisplay = document.getElementById('timer');
        this.newGameBtn = document.getElementById('newGameBtn');
        this.difficultySelect = document.getElementById('difficulty');

        // 游戏状态
        this.grid = [];
        this.isGameOver = false;
        this.isFirstClick = true;
        this.timerInterval = null;
        this.seconds = 0;
        this.flaggedCount = 0;
        this.revealedCount = 0;

        // 当前难度
        this.difficulty = 'beginner';
        this.rows = DIFFICULTY_SETTINGS[this.difficulty].rows;
        this.cols = DIFFICULTY_SETTINGS[this.difficulty].cols;
        this.totalMines = DIFFICULTY_SETTINGS[this.difficulty].mines;

        // 初始化事件监听
        this.initEventListeners();
        
        // 在手机端，为非初级难度添加特殊类
        const gameContainer = document.querySelector('.game-container');
        if (this.difficulty === 'beginner') {
            gameContainer.classList.remove('non-beginner');
        } else {
            gameContainer.classList.add('non-beginner');
        }
        
        // 开始新游戏
        this.startNewGame();
    }

    // 初始化事件监听
    initEventListeners() {
        this.newGameBtn.addEventListener('click', () => this.startNewGame());
        
        this.difficultySelect.addEventListener('change', () => {
            this.difficulty = this.difficultySelect.value;
            this.rows = DIFFICULTY_SETTINGS[this.difficulty].rows;
            this.cols = DIFFICULTY_SETTINGS[this.difficulty].cols;
            this.totalMines = DIFFICULTY_SETTINGS[this.difficulty].mines;
            
            // 在手机端，为非初级难度添加特殊类
            const gameContainer = document.querySelector('.game-container');
            if (this.difficulty === 'beginner') {
                gameContainer.classList.remove('non-beginner');
            } else {
                gameContainer.classList.add('non-beginner');
            }
            
            this.startNewGame();
        });
        
        // 禁用游戏面板上的右键菜单（包括长按菜单）
        this.gameBoard.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            return false;
        });
    }

    // 开始新游戏
    startNewGame() {
        window.FleaRound.reset();
        // 重置游戏状态
        this.isGameOver = false;
        this.isFirstClick = true;
        this.seconds = 0;
        this.flaggedCount = 0;
        this.revealedCount = 0;
        this.newGameBtn.textContent = '😊';
        this.timerDisplay.textContent = '0';
        this.mineCountDisplay.textContent = this.totalMines;
        
        // 清除计时器
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
        
        // 创建游戏面板
        this.createGameBoard();
    }

    // 创建游戏面板
    createGameBoard() {
        // 清空游戏面板
        this.gameBoard.innerHTML = '';
        
        // 调整游戏面板的网格列数
        this.gameBoard.style.gridTemplateColumns = `repeat(${this.cols}, 30px)`;
        
        // 初始化网格数组
        this.grid = Array(this.rows).fill().map(() => Array(this.cols).fill().map(() => ({
            isMine: false,
            isRevealed: false,
            isFlagged: false,
            neighborMines: 0
        })));
        
        // 创建格子元素
        for (let row = 0; row < this.rows; row++) {
            for (let col = 0; col < this.cols; col++) {
                const cell = document.createElement('div');
                cell.className = 'cell';
                cell.dataset.row = row;
                cell.dataset.col = col;
                
                // 添加点击事件
                cell.addEventListener('click', (e) => this.handleCellClick(row, col));
                
                // 添加右键点击事件（标记）
                cell.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    this.handleCellRightClick(row, col);
                });
                
                // 添加长按事件（用于手机端标记）
                let touchStartTime = 0;
                let touchTimer = null;
                let touchStartX = 0;
                let touchStartY = 0;
                const longPressDuration = 500; // 长按阈值（毫秒）
                const moveThreshold = 10; // 移动阈值（像素）
                
                cell.addEventListener('touchstart', (e) => {
                    // 立即阻止默认行为
                    e.preventDefault();
                    
                    // 使用requestAnimationFrame来确保我们的逻辑在下一帧执行
                    requestAnimationFrame(() => {
                        // 记录触摸开始时间和位置
                        touchStartTime = Date.now();
                        touchStartX = e.touches[0].clientX;
                        touchStartY = e.touches[0].clientY;
                        
                        // 设置长按定时器
                        touchTimer = setTimeout(() => {
                            // 长按时间到，执行右键点击操作
                            this.handleCellRightClick(row, col);
                            touchTimer = null;
                        }, longPressDuration);
                    });
                }, { passive: false }); // 明确指定不是被动监听器
                
                cell.addEventListener('touchend', (e) => {
                    // 立即阻止默认行为
                    e.preventDefault();
                    
                    // 计算触摸持续时间
                    const touchDuration = Date.now() - touchStartTime;
                    
                    // 清除长按定时器
                    if (touchTimer) {
                        clearTimeout(touchTimer);
                        touchTimer = null;
                        
                        // 如果触摸时间短于长按阈值，执行普通点击
                        if (touchDuration < longPressDuration) {
                            this.handleCellClick(row, col);
                        }
                    }
                }, { passive: false }); // 明确指定不是被动监听器
                
                cell.addEventListener('touchmove', (e) => {
                    // 阻止默认行为（防止滚动）
                    e.preventDefault();
                    
                    // 计算移动距离
                    const moveX = Math.abs(e.touches[0].clientX - touchStartX);
                    const moveY = Math.abs(e.touches[0].clientY - touchStartY);
                    
                    // 如果移动距离超过阈值，取消长按
                    if (moveX > moveThreshold || moveY > moveThreshold) {
                        if (touchTimer) {
                            clearTimeout(touchTimer);
                            touchTimer = null;
                        }
                    }
                }, { passive: false }); // 明确指定不是被动监听器
                
                this.gameBoard.appendChild(cell);
            }
        }
    }

    // 放置地雷（在第一次点击后）
    placeMines(firstRow, firstCol) {
        let minesPlaced = 0;
        
        while (minesPlaced < this.totalMines) {
            const row = Math.floor(Math.random() * this.rows);
            const col = Math.floor(Math.random() * this.cols);
            
            // 确保不在第一次点击的位置及其周围放置地雷
            if (!this.grid[row][col].isMine && 
                (Math.abs(row - firstRow) > 1 || Math.abs(col - firstCol) > 1)) {
                this.grid[row][col].isMine = true;
                minesPlaced++;
            }
        }
        
        // 计算每个格子周围的地雷数量
        this.calculateNeighborMines();
    }

    // 计算每个格子周围的地雷数量
    calculateNeighborMines() {
        for (let row = 0; row < this.rows; row++) {
            for (let col = 0; col < this.cols; col++) {
                if (!this.grid[row][col].isMine) {
                    let count = 0;
                    
                    // 检查周围8个方向
                    for (let r = Math.max(0, row - 1); r <= Math.min(this.rows - 1, row + 1); r++) {
                        for (let c = Math.max(0, col - 1); c <= Math.min(this.cols - 1, col + 1); c++) {
                            if (this.grid[r][c].isMine) {
                                count++;
                            }
                        }
                    }
                    
                    this.grid[row][col].neighborMines = count;
                }
            }
        }
    }

    // 处理格子点击
    handleCellClick(row, col) {
        // 如果游戏已结束或格子已被标记，则不做任何操作
        if (this.isGameOver || this.grid[row][col].isFlagged || this.grid[row][col].isRevealed) {
            return;
        }
        window.FleaRound.action('reveal', `${row},${col}`);
        
        // 如果是第一次点击
        if (this.isFirstClick) {
            this.isFirstClick = false;
            this.placeMines(row, col);
            this.startTimer();
        }
        
        // 如果点击到地雷，游戏结束
        if (this.grid[row][col].isMine) {
            this.gameOver(false);
            return;
        }
        
        // 揭示格子
        this.revealCell(row, col);
        
        // 检查是否获胜
        this.checkWin();
    }

    // 处理格子右键点击（标记）
    handleCellRightClick(row, col) {
        // 如果游戏已结束或格子已被揭示，则不做任何操作
        if (this.isGameOver || this.grid[row][col].isRevealed) {
            return;
        }
        
        const cell = this.grid[row][col];
        
        // 切换标记状态
        if (cell.isFlagged) {
            cell.isFlagged = false;
            this.flaggedCount--;
        } else {
            cell.isFlagged = true;
            this.flaggedCount++;
        }
        
        // 更新显示
        this.updateCellDisplay(row, col);
        this.mineCountDisplay.textContent = this.totalMines - this.flaggedCount;
    }

    // 揭示格子
    revealCell(row, col) {
        const cell = this.grid[row][col];
        
        // 如果格子已被揭示或已被标记，则不做任何操作
        if (cell.isRevealed || cell.isFlagged) {
            return;
        }
        
        // 标记为已揭示
        cell.isRevealed = true;
        this.revealedCount++;
        
        // 更新显示
        this.updateCellDisplay(row, col);
        
        // 如果周围没有地雷，自动揭示周围的格子
        if (cell.neighborMines === 0) {
            for (let r = Math.max(0, row - 1); r <= Math.min(this.rows - 1, row + 1); r++) {
                for (let c = Math.max(0, col - 1); c <= Math.min(this.cols - 1, col + 1); c++) {
                    if (r !== row || c !== col) {
                        this.revealCell(r, c);
                    }
                }
            }
        }
    }

    // 更新格子显示
    updateCellDisplay(row, col) {
        const cell = this.grid[row][col];
        const cellElement = document.querySelector(`.cell[data-row="${row}"][data-col="${col}"]`);
        
        // 重置类名
        cellElement.className = 'cell';
        
        if (cell.isRevealed) {
            cellElement.classList.add('revealed');
            
            if (cell.isMine) {
                cellElement.classList.add('mine');
                cellElement.textContent = '💣';
            } else if (cell.neighborMines > 0) {
                cellElement.dataset.number = cell.neighborMines;
                cellElement.textContent = cell.neighborMines;
            } else {
                cellElement.textContent = '';
            }
        } else if (cell.isFlagged) {
            cellElement.classList.add('flagged');
            cellElement.textContent = '🚩';
        } else {
            cellElement.textContent = '';
        }
    }

    // 揭示所有地雷
    revealAllMines() {
        for (let row = 0; row < this.rows; row++) {
            for (let col = 0; col < this.cols; col++) {
                if (this.grid[row][col].isMine) {
                    this.grid[row][col].isRevealed = true;
                    this.updateCellDisplay(row, col);
                }
            }
        }
    }

    // 开始计时器
    startTimer() {
        this.timerInterval = setInterval(() => {
            this.seconds++;
            this.timerDisplay.textContent = this.seconds;
        }, 1000);
    }

    // 检查是否获胜
    checkWin() {
        const totalCells = this.rows * this.cols;
        const nonMineCells = totalCells - this.totalMines;
        
        if (this.revealedCount === nonMineCells) {
            this.gameOver(true);
        }
    }

    // 游戏结束
    gameOver(isWin) {
        window.FleaRound.finish(isWin, {
            difficultyLevel: this.totalMines === 99 ? 3 : this.totalMines === 40 ? 2 : 1,
            progress: isWin ? 1 : this.revealedCount / (this.rows * this.cols - this.totalMines),
        });
        this.isGameOver = true;
        
        // 停止计时器
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
        
        if (isWin) {
            this.newGameBtn.textContent = '😎';
            // 标记所有未标记的地雷
            for (let row = 0; row < this.rows; row++) {
                for (let col = 0; col < this.cols; col++) {
                    if (this.grid[row][col].isMine && !this.grid[row][col].isFlagged) {
                        this.grid[row][col].isFlagged = true;
                        this.updateCellDisplay(row, col);
                    }
                }
            }
            setTimeout(() => Toast.success('恭喜你赢了！'), 100);
        } else {
            this.newGameBtn.textContent = '😵';
            this.revealAllMines();
            setTimeout(() => Toast.error('游戏结束！'), 100);
        }
    }
}

// 当页面加载完成后初始化游戏
document.addEventListener('DOMContentLoaded', () => {
    // 全局禁用上下文菜单（右键菜单和长按菜单）
    document.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        return false;
    });
    
    // 全局禁用文本选择
    document.addEventListener('selectstart', (e) => {
        e.preventDefault();
        return false;
    });
    
    // 全局禁用触摸长按
    document.addEventListener('touchstart', (e) => {
        // 不阻止所有触摸事件，只阻止长按
        const target = e.target;
        if (target.closest('#gameBoard')) {
            // 游戏面板内的触摸事件已经在各自的处理程序中处理
            return;
        }
        
        // 对于游戏面板外的元素，阻止长按菜单
        const longPressTimer = setTimeout(() => {
            e.preventDefault();
        }, 300);
        
        document.addEventListener('touchend', () => {
            clearTimeout(longPressTimer);
        }, { once: true });
    }, { passive: false });
    
    new MinesweeperGame();
});